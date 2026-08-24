import type { Entry } from '@dudousxd/nestjs-telescope';
import { describe, expect, it } from 'vitest';
import type { AssembledBatch } from '../assemble/assembled-batch.js';
import { resolveObserveOptions } from '../observe-options.js';
import { encodeSnapshot } from './snapshot.encoder.js';

const ROOT_START = Date.parse('2026-01-01T00:00:00.000Z');

function options(spans = true) {
  return resolveObserveOptions({
    appKey: 'k',
    appSecret: 's',
    serviceId: 'flip-api',
    include: { spans },
  });
}

function entry(type: string, content: unknown, overrides: Partial<Entry> = {}): Entry {
  return {
    id: `e-${type}-${overrides.sequence ?? 0}`,
    batchId: 'batch-1',
    type,
    familyHash: null,
    content,
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'i1',
    traceId: null,
    spanId: null,
    createdAt: new Date(ROOT_START),
    ...overrides,
  } as Entry;
}

function requestRoot(content: Record<string, unknown> = {}, overrides: Partial<Entry> = {}): Entry {
  return entry(
    'request',
    {
      method: 'GET',
      uri: '/orders/42?page=2',
      headers: {},
      payload: null,
      user: null,
      response: null,
      statusCode: 200,
      ip: '1.2.3.4',
      memoryMb: 12,
      ...content,
    },
    { durationMs: 120, ...overrides },
  );
}

function batch(root: Entry | null, children: Entry[] = []): AssembledBatch {
  return { batchId: 'batch-1', origin: 'http', root, children };
}

describe('encodeSnapshot', () => {
  it('returns null when the batch is not rooted at a request', () => {
    expect(encodeSnapshot(batch(null), options())).toBeNull();
    expect(
      encodeSnapshot(batch(entry('job', { name: 'x', status: 'completed' })), options()),
    ).toBeNull();
    expect(encodeSnapshot(batch(entry('request', null)), options())).toBeNull();
  });

  it('maps the request envelope', () => {
    const snapshot = encodeSnapshot(batch(requestRoot()), options());

    // `ct` is when the request BEGAN. The entry is recorded on response finish,
    // so its `createdAt` is the end and `d` walks it back.
    expect(snapshot?.ct).toBe(new Date(ROOT_START - 120).toISOString());
    expect(snapshot?.p).toBe('http');
    expect(snapshot?.d).toBe(120);
    expect(snapshot?.op).toBe('GET /orders/:id');
    expect(snapshot?.a).toEqual({ m: 'GET', sc: 200, ou: '/orders/42?page=2' });
  });

  it('never emits st, which their collector 400s on', () => {
    const snapshot = encodeSnapshot(
      batch(requestRoot(), [entry('query', { sql: 'SELECT 1' })]),
      options(),
    );

    expect(snapshot).not.toHaveProperty('st');
    expect(JSON.stringify(snapshot)).not.toContain('"st"');
  });

  it('falls back to the batch id when there is no trace id', () => {
    expect(encodeSnapshot(batch(requestRoot()), options())?.ti).toBe('batch-1');
    expect(encodeSnapshot(batch(requestRoot({}, { traceId: 'trace-9' })), options())?.ti).toBe(
      'trace-9',
    );
  });

  it('derives the user id from id, then _id, then email', () => {
    expect(encodeSnapshot(batch(requestRoot({ user: { id: 42 } })), options())?.u).toBe('42');
    expect(encodeSnapshot(batch(requestRoot({ user: { _id: 'abc' } })), options())?.u).toBe('abc');
    expect(encodeSnapshot(batch(requestRoot({ user: { email: 'a@test' } })), options())?.u).toBe(
      'a@test',
    );
  });

  it('omits the user id when the request is anonymous', () => {
    expect(encodeSnapshot(batch(requestRoot({ user: null })), options())).not.toHaveProperty('u');
    expect(encodeSnapshot(batch(requestRoot({ user: {} })), options())).not.toHaveProperty('u');
  });

  it('splits k:v tags, marks bare ones true, and always stamps the origin', () => {
    const snapshot = encodeSnapshot(
      batch(requestRoot({}, { tags: ['status:200', 'slow', 'queue:emails:retry'] })),
      options(),
    );

    expect(snapshot?.tg).toEqual({
      status: '200',
      slow: true,
      queue: 'emails:retry',
      origin: 'http',
    });
  });

  it('drops the user tag, which would only duplicate u at unbounded cardinality', () => {
    const snapshot = encodeSnapshot(
      batch(requestRoot({ user: { id: 42 } }, { tags: ['user:42', 'status:200'] })),
      options(),
    );

    expect(snapshot?.tg).not.toHaveProperty('user');
    expect(snapshot?.u).toBe('42');
  });

  it('turns the remaining children into spans', () => {
    // The request ran [ROOT_START - 120, ROOT_START]; the query ran inside it,
    // finishing 20ms before the response after 8ms of work.
    const snapshot = encodeSnapshot(
      batch(requestRoot(), [
        entry(
          'query',
          { sql: 'SELECT 1' },
          {
            createdAt: new Date(ROOT_START - 20),
            durationMs: 8,
          },
        ),
        entry('cache', { operation: 'get', key: 'k', hit: false }, { sequence: 1 }),
      ]),
      options(),
    );

    expect(snapshot?.t?.map((span) => span.n)).toEqual(['db.query', 'cache.get']);
    // (ROOT_START - 28) - (ROOT_START - 120)
    expect(snapshot?.t?.[0]?.so).toBe(92);
  });

  it('positions every span against the request start, not its end', () => {
    // Without walking the root back by its duration, every child would land
    // before it and clamp to zero — the whole waterfall in one column.
    const snapshot = encodeSnapshot(
      batch(requestRoot(), [
        entry('query', { sql: 'SELECT 1' }, { createdAt: new Date(ROOT_START - 100) }),
        entry(
          'query',
          { sql: 'SELECT 2' },
          {
            sequence: 1,
            createdAt: new Date(ROOT_START - 40),
          },
        ),
      ]),
      options(),
    );

    expect(snapshot?.t?.map((span) => span.so)).toEqual([20, 80]);
  });

  it('never re-encodes a record type as a span', () => {
    // A host that registers request capture twice puts two `request` entries in
    // one batch; the assembler demotes the second to a child. It is not a span
    // inside itself, and a job belongs in `jobs[]` — either would be a paid
    // duplicate that says nothing.
    const snapshot = encodeSnapshot(
      batch(requestRoot(), [
        requestRoot({}, { sequence: 1, id: 'dup-request' }),
        entry('job', { id: 'j1', name: 'x', queue: 'q', status: 'completed' }, { sequence: 2 }),
        entry('query', { sql: 'SELECT 1' }, { sequence: 3 }),
      ]),
      options(),
    );

    expect(snapshot?.t?.map((span) => span.n)).toEqual(['db.query']);
  });

  it('leaves log children to the logs section', () => {
    const snapshot = encodeSnapshot(
      batch(requestRoot(), [
        entry('log', { level: 'warn', message: 'hm', context: 'Svc' }),
        entry('query', { sql: 'SELECT 1' }, { sequence: 1 }),
      ]),
      options(),
    );

    expect(snapshot?.t?.map((span) => span.n)).toEqual(['db.query']);
  });

  it('lifts the exception onto e and does not also ship it as a span', () => {
    const failure = entry(
      'exception',
      { class: 'TypeError', message: 'boom', stack: null, context: {} },
      { id: 'exc-1', sequence: 1 },
    );
    const snapshot = encodeSnapshot(
      batch(requestRoot({ statusCode: 500 }), [entry('query', { sql: 'SELECT 1' }), failure]),
      options(),
    );

    expect(snapshot?.e).toEqual({ cls: 'TypeError', message: 'boom' });
    expect(snapshot?.t?.map((span) => span.n)).toEqual(['db.query']);
  });

  it('prefers the server exception over a browser-reported one', () => {
    const snapshot = encodeSnapshot(
      batch(requestRoot(), [
        entry(
          'client_exception',
          { message: 'from the browser', name: null, stack: null, url: null },
          { id: 'cli-1' },
        ),
        entry(
          'exception',
          { class: 'RangeError', message: 'from the server', stack: null, context: {} },
          { id: 'exc-1', sequence: 1 },
        ),
      ]),
      options(),
    );

    expect(snapshot?.e?.message).toBe('from the server');
    expect(snapshot?.t?.map((span) => span.n)).toEqual(['telescope.client_exception']);
  });

  it('always emits t, empty rather than absent', () => {
    // The collector rejects a snapshot whose `t` is missing — `snapshots.N.t
    // must be an array` — so "no spans" is `[]`, not an omitted key.
    expect(
      encodeSnapshot(batch(requestRoot(), [entry('query', { sql: 'S' })]), options(false))?.t,
    ).toEqual([]);
    expect(encodeSnapshot(batch(requestRoot()), options())?.t).toEqual([]);
  });
});
