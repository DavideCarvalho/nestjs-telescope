import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { detectNPlusOnePatterns, toSyntheticInsightEntry } from './n-plus-one-pattern.js';

let seq = 0;
function query(over: Partial<Entry>): Entry {
  return {
    id: `id-${seq}`,
    batchId: 'b',
    type: 'query',
    familyHash: null,
    content: { sql: 'x' },
    tags: [],
    sequence: seq++,
    durationMs: 1,
    origin: 'http',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt: new Date(seq * 1000),
    ...over,
  };
}

describe('detectNPlusOnePatterns', () => {
  it('detects the classic 1 parent + N similar children loop', () => {
    seq = 0;
    const entries: Entry[] = [
      // The parent query that drives the loop.
      query({ familyHash: 'authors', content: { sql: 'select * from author' }, durationMs: 5 }),
      // N child queries of the same shape.
      query({
        familyHash: 'book',
        content: { sql: 'select * from book where author_id = ?' },
        durationMs: 3,
      }),
      query({
        familyHash: 'book',
        content: { sql: 'select * from book where author_id = ?' },
        durationMs: 3,
      }),
      query({
        familyHash: 'book',
        content: { sql: 'select * from book where author_id = ?' },
        durationMs: 4,
      }),
    ];
    const patterns = detectNPlusOnePatterns(entries, { threshold: 3 });
    expect(patterns).toHaveLength(1);
    const p = patterns[0];
    expect(p?.childFamilyHash).toBe('book');
    expect(p?.count).toBe(3);
    // The likely parent is the distinct query that immediately precedes the loop.
    expect(p?.parentFamilyHash).toBe('authors');
    expect(p?.parentSql).toContain('author');
    expect(p?.childSql).toContain('book');
  });

  it('weights by total child duration', () => {
    seq = 0;
    const entries: Entry[] = [
      query({ familyHash: 'p', content: { sql: 'select * from p' }, durationMs: 1 }),
      query({ familyHash: 'c', content: { sql: 'select * from c where id = ?' }, durationMs: 10 }),
      query({ familyHash: 'c', content: { sql: 'select * from c where id = ?' }, durationMs: 20 }),
      query({ familyHash: 'c', content: { sql: 'select * from c where id = ?' }, durationMs: 30 }),
    ];
    const patterns = detectNPlusOnePatterns(entries, { threshold: 3 });
    expect(patterns[0]?.totalDurationMs).toBe(60);
  });

  it('ranks patterns by total wasted duration, not just count', () => {
    seq = 0;
    const entries: Entry[] = [
      // family "fast": many but cheap (5 x 1ms = 5ms total)
      ...Array.from({ length: 5 }, () =>
        query({ familyHash: 'fast', content: { sql: 'select 1 where id = ?' }, durationMs: 1 }),
      ),
      // family "slow": fewer but expensive (3 x 50ms = 150ms total)
      ...Array.from({ length: 3 }, () =>
        query({ familyHash: 'slow', content: { sql: 'select 2 where id = ?' }, durationMs: 50 }),
      ),
    ];
    const patterns = detectNPlusOnePatterns(entries, { threshold: 3 });
    expect(patterns.map((p) => p.childFamilyHash)).toEqual(['slow', 'fast']);
  });

  it('does not flag below the threshold', () => {
    seq = 0;
    const entries: Entry[] = [
      query({ familyHash: 'p', content: { sql: 'select * from p' } }),
      query({ familyHash: 'c', content: { sql: 'select * from c where id = ?' } }),
      query({ familyHash: 'c', content: { sql: 'select * from c where id = ?' } }),
    ];
    expect(detectNPlusOnePatterns(entries, { threshold: 3 })).toEqual([]);
  });

  it('reports no parent when the loop is the very first thing in the batch', () => {
    seq = 0;
    const entries: Entry[] = [
      query({ familyHash: 'c', content: { sql: 'select * from c where id = ?' } }),
      query({ familyHash: 'c', content: { sql: 'select * from c where id = ?' } }),
      query({ familyHash: 'c', content: { sql: 'select * from c where id = ?' } }),
    ];
    const patterns = detectNPlusOnePatterns(entries, { threshold: 3 });
    expect(patterns).toHaveLength(1);
    expect(patterns[0]?.parentFamilyHash).toBeNull();
  });

  it('builds a synthetic insight entry via toSyntheticEntry', () => {
    seq = 0;
    const entries: Entry[] = [
      query({ familyHash: 'p', content: { sql: 'select * from p' }, batchId: 'batch-9' }),
      query({
        familyHash: 'c',
        content: { sql: 'select * from c where id = ?' },
        batchId: 'batch-9',
      }),
      query({
        familyHash: 'c',
        content: { sql: 'select * from c where id = ?' },
        batchId: 'batch-9',
      }),
      query({
        familyHash: 'c',
        content: { sql: 'select * from c where id = ?' },
        batchId: 'batch-9',
      }),
    ];
    const patterns = detectNPlusOnePatterns(entries, { threshold: 3 });
    expect(patterns[0]).toBeDefined();
    const synthetic = toSyntheticInsightEntry(patterns[0] as NonNullable<(typeof patterns)[0]>);
    expect(synthetic.type).toBe('insight');
    expect(synthetic.batchId).toBe('batch-9');
    expect(synthetic.tags).toContain('n-plus-one');
    expect(synthetic.content.kind).toBe('n-plus-one');
    expect(synthetic.content.count).toBe(3);
    expect(synthetic.content.message).toContain('N+1');
    // Deterministic id (idempotent re-ingestion).
    const again = toSyntheticInsightEntry(patterns[0] as NonNullable<(typeof patterns)[0]>);
    expect(again.id).toBe(synthetic.id);
  });
});
