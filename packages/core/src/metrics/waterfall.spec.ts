import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { buildWaterfall } from './waterfall.js';

function entry(over: Partial<Entry> & { type: string; createdAt: Date }): Entry {
  return {
    id: `e-${Math.random()}`,
    batchId: 'b',
    familyHash: null,
    content: {},
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'i',
    traceId: 't1',
    spanId: null,
    ...over,
  };
}

describe('buildWaterfall', () => {
  it('returns null when no entries are given', () => {
    expect(buildWaterfall([])).toBeNull();
  });

  it('nests a child whose interval is contained in the parent', () => {
    // Request spans [0, 100]; the query spans [10, 30] — fully inside the request.
    const wf = buildWaterfall([
      entry({
        id: 'req',
        type: 'request',
        createdAt: new Date(1000),
        durationMs: 100,
        sequence: 0,
        content: { method: 'GET', uri: '/users' },
      }),
      entry({
        id: 'q1',
        type: 'query',
        createdAt: new Date(1010),
        durationMs: 20,
        sequence: 1,
        content: { sql: 'select 1' },
      }),
    ]);
    expect(wf).not.toBeNull();
    if (wf === null) return;
    expect(wf.traceStartMs).toBe(1000);
    expect(wf.totalDurationMs).toBe(100);
    // One root (the request), with the query nested as a child.
    expect(wf.spans).toHaveLength(1);
    const root = wf.spans[0];
    expect(root?.id).toBe('req');
    expect(root?.offsetMs).toBe(0);
    expect(root?.durationMs).toBe(100);
    expect(root?.depth).toBe(0);
    expect(root?.children).toHaveLength(1);
    const child = root?.children[0];
    expect(child?.id).toBe('q1');
    // Offset is relative to the trace start (1010 - 1000 = 10).
    expect(child?.offsetMs).toBe(10);
    expect(child?.durationMs).toBe(20);
    expect(child?.depth).toBe(1);
  });

  it('keeps siblings flat when their intervals do not contain each other', () => {
    const wf = buildWaterfall([
      entry({ id: 'req', type: 'request', createdAt: new Date(0), durationMs: 100, sequence: 0 }),
      entry({ id: 'q1', type: 'query', createdAt: new Date(10), durationMs: 20, sequence: 1 }),
      entry({ id: 'q2', type: 'query', createdAt: new Date(40), durationMs: 20, sequence: 2 }),
    ]);
    if (wf === null) throw new Error('expected waterfall');
    expect(wf.spans).toHaveLength(1);
    const root = wf.spans[0];
    expect(root?.children.map((c) => c.id)).toEqual(['q1', 'q2']);
    expect(root?.children[0]?.depth).toBe(1);
    expect(root?.children[1]?.depth).toBe(1);
  });

  it('builds deep nesting (request > query > nested op)', () => {
    const wf = buildWaterfall([
      entry({ id: 'req', type: 'request', createdAt: new Date(0), durationMs: 100, sequence: 0 }),
      entry({
        id: 'outer',
        type: 'http_client',
        createdAt: new Date(10),
        durationMs: 50,
        sequence: 1,
      }),
      entry({ id: 'inner', type: 'query', createdAt: new Date(20), durationMs: 10, sequence: 2 }),
    ]);
    if (wf === null) throw new Error('expected waterfall');
    const root = wf.spans[0];
    expect(root?.id).toBe('req');
    const outer = root?.children[0];
    expect(outer?.id).toBe('outer');
    expect(outer?.depth).toBe(1);
    expect(outer?.children[0]?.id).toBe('inner');
    expect(outer?.children[0]?.depth).toBe(2);
  });

  it('treats a null durationMs as a zero-width instant span', () => {
    const wf = buildWaterfall([
      entry({ id: 'req', type: 'request', createdAt: new Date(0), durationMs: 100, sequence: 0 }),
      entry({ id: 'log', type: 'log', createdAt: new Date(30), durationMs: null, sequence: 1 }),
    ]);
    if (wf === null) throw new Error('expected waterfall');
    const root = wf.spans[0];
    const log = root?.children[0];
    expect(log?.id).toBe('log');
    expect(log?.durationMs).toBe(0);
    expect(log?.offsetMs).toBe(30);
  });

  it('orders spans by start offset then sequence', () => {
    // Same createdAt; sequence breaks the tie.
    const wf = buildWaterfall([
      entry({ id: 'req', type: 'request', createdAt: new Date(0), durationMs: 100, sequence: 0 }),
      entry({ id: 'b', type: 'query', createdAt: new Date(10), durationMs: 5, sequence: 2 }),
      entry({ id: 'a', type: 'query', createdAt: new Date(10), durationMs: 5, sequence: 1 }),
    ]);
    if (wf === null) throw new Error('expected waterfall');
    expect(wf.spans[0]?.children.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('derives a label per span from content', () => {
    const wf = buildWaterfall([
      entry({
        id: 'req',
        type: 'request',
        createdAt: new Date(0),
        durationMs: 100,
        sequence: 0,
        content: { method: 'POST', uri: '/orders' },
      }),
      entry({
        id: 'q1',
        type: 'query',
        createdAt: new Date(10),
        durationMs: 5,
        sequence: 1,
        content: { sql: 'select * from orders' },
      }),
    ]);
    if (wf === null) throw new Error('expected waterfall');
    expect(wf.spans[0]?.label).toBe('POST /orders');
    expect(wf.spans[0]?.children[0]?.label).toBe('select * from orders');
  });
});
