// packages/mikro-orm/src/n-plus-one.spec.ts
import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { detectNPlusOne } from './n-plus-one.js';

function query(over: Partial<Entry>): Entry {
  return {
    id: 'id',
    batchId: 'b',
    type: 'query',
    familyHash: null,
    content: { sql: 'x' },
    tags: [],
    sequence: 0,
    durationMs: 1,
    origin: 'http',
    instanceId: 'i',
    createdAt: new Date(),
    ...over,
  };
}

describe('detectNPlusOne', () => {
  it('flags a query template that runs at least `threshold` times', () => {
    const entries: Entry[] = [
      query({ familyHash: 'h1', content: { sql: 'select * from book where author_id = ?' } }),
      query({ familyHash: 'h1', content: { sql: 'select * from book where author_id = ?' } }),
      query({ familyHash: 'h1', content: { sql: 'select * from book where author_id = ?' } }),
      query({ familyHash: 'h2', content: { sql: 'select * from author' } }),
    ];
    const insights = detectNPlusOne(entries, 3);
    expect(insights).toHaveLength(1);
    expect(insights[0]).toMatchObject({ familyHash: 'h1', count: 3 });
    expect(insights[0]?.sql).toContain('book');
  });

  it('ignores non-query entries and templates under threshold', () => {
    const entries: Entry[] = [
      query({ familyHash: 'h1' }),
      query({ familyHash: 'h1' }),
      { ...query({ familyHash: 'h1' }), type: 'request' },
    ];
    expect(detectNPlusOne(entries, 3)).toEqual([]);
  });

  it('skips entries without a familyHash', () => {
    expect(detectNPlusOne([query({ familyHash: null }), query({ familyHash: null })], 2)).toEqual(
      [],
    );
  });
});
