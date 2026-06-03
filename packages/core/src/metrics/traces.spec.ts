import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { summarizeTraces } from './traces.js';

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

describe('summarizeTraces', () => {
  it('groups entries by traceId', () => {
    const summaries = summarizeTraces([
      entry({ type: 'request', traceId: 't1', createdAt: new Date(1000) }),
      entry({ type: 'query', traceId: 't1', createdAt: new Date(1500) }),
      entry({ type: 'request', traceId: 't2', createdAt: new Date(2000) }),
    ]);
    expect(summaries).toHaveLength(2);
    const t1 = summaries.find((s) => s.traceId === 't1');
    expect(t1?.entryCount).toBe(2);
  });

  it('excludes entries with a null traceId', () => {
    const summaries = summarizeTraces([
      entry({ type: 'request', traceId: null, createdAt: new Date(1000) }),
      entry({ type: 'request', traceId: 't1', createdAt: new Date(1000) }),
    ]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.traceId).toBe('t1');
  });

  it('lists distinct types sorted ascending', () => {
    const summaries = summarizeTraces([
      entry({ type: 'request', traceId: 't1', createdAt: new Date(1000) }),
      entry({ type: 'query', traceId: 't1', createdAt: new Date(1000) }),
      entry({ type: 'query', traceId: 't1', createdAt: new Date(1000) }),
      entry({ type: 'cache', traceId: 't1', createdAt: new Date(1000) }),
    ]);
    expect(summaries[0]?.types).toEqual(['cache', 'query', 'request']);
  });

  it('sums non-null durationMs and ignores nulls', () => {
    const summaries = summarizeTraces([
      entry({ type: 'request', traceId: 't1', createdAt: new Date(1000), durationMs: 10 }),
      entry({ type: 'query', traceId: 't1', createdAt: new Date(1000), durationMs: null }),
      entry({ type: 'query', traceId: 't1', createdAt: new Date(1000), durationMs: 5 }),
    ]);
    expect(summaries[0]?.totalDurationMs).toBe(15);
  });

  it('tracks firstAt and lastAt across the trace', () => {
    const summaries = summarizeTraces([
      entry({ type: 'request', traceId: 't1', createdAt: new Date(3000) }),
      entry({ type: 'query', traceId: 't1', createdAt: new Date(1000) }),
      entry({ type: 'query', traceId: 't1', createdAt: new Date(2000) }),
    ]);
    expect(summaries[0]?.firstAt).toEqual(new Date(1000));
    expect(summaries[0]?.lastAt).toEqual(new Date(3000));
  });

  it('orders traces by lastAt descending', () => {
    const summaries = summarizeTraces([
      entry({ type: 'request', traceId: 'old', createdAt: new Date(1000) }),
      entry({ type: 'request', traceId: 'new', createdAt: new Date(5000) }),
      entry({ type: 'request', traceId: 'mid', createdAt: new Date(3000) }),
    ]);
    expect(summaries.map((s) => s.traceId)).toEqual(['new', 'mid', 'old']);
  });

  it('slices to the requested limit', () => {
    const entries = Array.from({ length: 10 }, (_, index) =>
      entry({ type: 'request', traceId: `t${index}`, createdAt: new Date(index * 1000) }),
    );
    const summaries = summarizeTraces(entries, { limit: 3 });
    expect(summaries).toHaveLength(3);
    expect(summaries.map((s) => s.traceId)).toEqual(['t9', 't8', 't7']);
  });

  it('defaults the limit to 50', () => {
    const entries = Array.from({ length: 60 }, (_, index) =>
      entry({ type: 'request', traceId: `t${index}`, createdAt: new Date(index * 1000) }),
    );
    expect(summarizeTraces(entries)).toHaveLength(50);
  });

  it('derives rootLabel from the request entry (method + uri)', () => {
    const summaries = summarizeTraces([
      entry({
        type: 'request',
        traceId: 't1',
        createdAt: new Date(1000),
        content: { method: 'GET', uri: '/users' },
      }),
      entry({
        type: 'query',
        traceId: 't1',
        createdAt: new Date(1000),
        content: { sql: 'select 1' },
      }),
    ]);
    expect(summaries[0]?.rootLabel).toBe('GET /users');
  });

  it('leaves rootLabel undefined when no request entry is present', () => {
    const summaries = summarizeTraces([
      entry({
        type: 'query',
        traceId: 't1',
        createdAt: new Date(1000),
        content: { sql: 'select 1' },
      }),
    ]);
    expect(summaries[0]?.rootLabel).toBeUndefined();
  });
});
