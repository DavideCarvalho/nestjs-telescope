import type { Entry } from '@dudousxd/nestjs-telescope';
import { describe, expect, it } from 'vitest';
import { entryToSpan } from './entry-to-span.js';

const ROOT_START = Date.parse('2026-01-01T00:00:00.000Z');

function entry(type: string, content: unknown, overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'e1',
    batchId: 'b1',
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

describe('entryToSpan names', () => {
  it.each([
    ['query', { sql: 'SELECT 1', bindings: [], connection: null, slow: false }, 'db.query'],
    ['cache', { operation: 'get', key: 'k', hit: true }, 'cache.get'],
    ['redis', { command: 'GET', args: [], durationMs: 1 }, 'redis.GET'],
    ['http_client', { method: 'GET', url: 'https://a.test/x', host: 'a.test' }, 'http.client'],
    ['mail', { mailer: 'smtp', to: [], status: 'sent' }, 'mail.send'],
    ['model', { action: 'update', entity: 'Order', id: '1', changes: null }, 'model.update'],
    ['event', { name: 'order.paid', payload: null, listenerCount: 2 }, 'event.order.paid'],
    ['inertia', { component: 'Orders' }, 'telescope.inertia'],
    ['dump', { label: null, value: 1 }, 'telescope.dump'],
  ])('%s becomes %s', (type, content, expected) => {
    expect(entryToSpan(entry(type, content), ROOT_START).n).toBe(expected);
  });

  it('falls back to telescope.<type> when the discriminator is missing', () => {
    expect(entryToSpan(entry('cache', { key: 'k' }), ROOT_START).n).toBe('telescope.cache');
    expect(entryToSpan(entry('redis', { args: [] }), ROOT_START).n).toBe('telescope.redis');
    expect(entryToSpan(entry('event', { payload: 1 }), ROOT_START).n).toBe('telescope.event');
    expect(entryToSpan(entry('model', { entity: 'Order' }), ROOT_START).n).toBe('telescope.model');
    expect(entryToSpan(entry('query', null), ROOT_START).n).toBe('telescope.query');
  });
});

describe('entryToSpan envelope', () => {
  it('is always auto and never carries a children array', () => {
    const span = entryToSpan(entry('query', { sql: 'SELECT 1' }), ROOT_START);

    expect(span.o).toBe('auto');
    expect(span).not.toHaveProperty('ch');
  });

  it('carries duration and span id, omitting both when absent', () => {
    const withBoth = entryToSpan(
      entry('query', { sql: 'SELECT 1' }, { durationMs: 12, spanId: 'sp-1' }),
      ROOT_START,
    );
    expect(withBoth.d).toBe(12);
    expect(withBoth.s).toBe('sp-1');

    const without = entryToSpan(entry('query', { sql: 'SELECT 1' }), ROOT_START);
    expect(without).not.toHaveProperty('d');
    expect(without).not.toHaveProperty('s');
  });

  it('offsets from the root start and clamps a child recorded before it', () => {
    const later = entryToSpan(
      entry('query', { sql: 'S' }, { createdAt: new Date(ROOT_START + 40) }),
      ROOT_START,
    );
    expect(later.so).toBe(40);

    const earlier = entryToSpan(
      entry('query', { sql: 'S' }, { createdAt: new Date(ROOT_START - 40) }),
      ROOT_START,
    );
    expect(earlier.so).toBe(0);
  });

  it('omits the offset when either clock reading is unusable', () => {
    const span = entryToSpan(entry('query', { sql: 'S' }), Number.NaN);
    expect(span).not.toHaveProperty('so');
  });

  it('carries the error for an exception entry', () => {
    const span = entryToSpan(
      entry('exception', { class: 'TypeError', message: 'boom', stack: null, context: {} }),
      ROOT_START,
    );

    expect(span.e).toEqual({ cls: 'TypeError', message: 'boom' });
  });

  it('omits tags rather than sending an empty map', () => {
    expect(entryToSpan(entry('dump', { label: null, value: 1 }), ROOT_START)).not.toHaveProperty(
      't',
    );
  });
});

describe('entryToSpan class and method keys', () => {
  it('fills both from a model entry', () => {
    const span = entryToSpan(
      entry('model', { action: 'create', entity: 'Order', id: '1', changes: null }),
      ROOT_START,
    );

    expect(span.c).toBe('Order');
    expect(span.m).toBe('create');
  });

  it('uses the connection as the class of a query', () => {
    const span = entryToSpan(
      entry('query', { sql: 'SELECT 1', bindings: [], connection: 'read', slow: false }),
      ROOT_START,
    );

    expect(span.c).toBe('read');
    // `m` is required by the collector; the span name supplies it.
    expect(span.m).toBe('query');
  });

  it('splits the span name when the entry knows neither', () => {
    // `c` and `m` are both required and capped at 255. Telescope's watchers
    // usually have no owning class, so the name — already written as
    // `<subject>.<operation>` — is what fills the pair.
    const span = entryToSpan(
      entry('http_client', { method: 'GET', url: 'https://a.test', host: 'a.test' }),
      ROOT_START,
    );

    expect(span.c).toBe('http');
    expect(span.m).toBe('client');
  });

  it('caps both identifiers at the 255-character limit the collector enforces', () => {
    const span = entryToSpan(
      entry('event', { name: 'e'.repeat(400), payload: null, listenerCount: 1 }),
      ROOT_START,
    );

    expect(span.m.length).toBe(255);
    expect(span.c.length).toBeLessThanOrEqual(255);
  });
});

describe('entryToSpan tags', () => {
  it('keeps the query shape but never the bindings', () => {
    const span = entryToSpan(
      entry('query', {
        sql: 'SELECT *\n  FROM users\n  WHERE ssn = ?',
        bindings: ['000-00-0000'],
        connection: 'default',
        slow: true,
      }),
      ROOT_START,
    );

    expect(span.t).toEqual({
      connection: 'default',
      slow: true,
      sql: 'SELECT * FROM users WHERE ssn = ?',
    });
    expect(JSON.stringify(span)).not.toContain('000-00-0000');
  });

  it('truncates a very long statement', () => {
    const span = entryToSpan(
      entry('query', { sql: `SELECT ${'x'.repeat(2000)}`, bindings: [] }),
      ROOT_START,
    );

    expect((span.t?.sql as string).length).toBe(512);
  });

  it('keeps cache dimensions but not the key or the cached value', () => {
    const span = entryToSpan(
      entry('cache', {
        operation: 'get',
        key: 'user:42:profile',
        hit: true,
        tier: 'l2',
        stale: false,
        store: 'sessions',
        metadata: { value: 'super-secret' },
      }),
      ROOT_START,
    );

    expect(span.t).toEqual({
      operation: 'get',
      hit: true,
      tier: 'l2',
      stale: false,
      store: 'sessions',
    });
    expect(JSON.stringify(span)).not.toContain('super-secret');
    expect(JSON.stringify(span)).not.toContain('user:42:profile');
  });

  it('keeps the redis command but not its arguments', () => {
    const span = entryToSpan(
      entry('redis', { command: 'SET', args: ['session:1', 'token-abc'], durationMs: 2 }),
      ROOT_START,
    );

    expect(span.t).toEqual({ command: 'SET' });
    expect(JSON.stringify(span)).not.toContain('token-abc');
  });

  it('keeps host and status for an outgoing call', () => {
    const span = entryToSpan(
      entry('http_client', {
        method: 'POST',
        url: 'https://api.stripe.com/v1/charges?key=sk_live',
        host: 'api.stripe.com',
        statusCode: 402,
        durationMs: 30,
      }),
      ROOT_START,
    );

    expect(span.t).toEqual({ method: 'POST', host: 'api.stripe.com', statusCode: 402 });
    expect(JSON.stringify(span)).not.toContain('sk_live');
  });

  it('keeps mail status but neither recipients nor body', () => {
    const span = entryToSpan(
      entry('mail', {
        mailer: 'ses',
        from: 'no-reply@test',
        to: ['victim@test'],
        subject: 'Your invoice',
        preview: '<p>Pay up</p>',
        status: 'failed',
      }),
      ROOT_START,
    );

    expect(span.t).toEqual({ mailer: 'ses', status: 'failed' });
    expect(JSON.stringify(span)).not.toContain('victim@test');
    expect(JSON.stringify(span)).not.toContain('Pay up');
  });

  it('keeps model and event dimensions but not their payloads', () => {
    const model = entryToSpan(
      entry('model', {
        action: 'update',
        entity: 'User',
        id: '9',
        changes: { password: 'hunter2' },
      }),
      ROOT_START,
    );
    expect(model.t).toEqual({ action: 'update', entity: 'User' });
    expect(JSON.stringify(model)).not.toContain('hunter2');

    const event = entryToSpan(
      entry('event', { name: 'order.paid', payload: { card: '4111' }, listenerCount: 3 }),
      ROOT_START,
    );
    expect(event.t).toEqual({ listeners: 3 });
    expect(JSON.stringify(event)).not.toContain('4111');
  });
});
