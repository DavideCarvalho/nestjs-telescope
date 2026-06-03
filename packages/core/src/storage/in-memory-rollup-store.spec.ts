import { describe, expect, it } from 'vitest';
import type { RollupBucket } from '../rollup/rollup-store.js';
import { isRollupStore } from '../rollup/rollup-store.js';
import { InMemoryStorageProvider } from './in-memory-storage-provider.js';

function sortBuckets(buckets: RollupBucket[]): RollupBucket[] {
  return [...buckets].sort(
    (a, b) => a.metric.localeCompare(b.metric) || a.bucketStart - b.bucketStart,
  );
}

describe('InMemoryStorageProvider RollupStore', () => {
  it('is detected as a rollup store', () => {
    expect(isRollupStore(new InMemoryStorageProvider())).toBe(true);
  });

  it('accumulates count/sum and keeps a running max across calls (same bucket merges)', async () => {
    const store = new InMemoryStorageProvider();
    await store.recordRollups([
      { metric: 'request', bucketStart: 60_000, count: 2, sum: 30, max: 20 },
    ]);
    await store.recordRollups([
      { metric: 'request', bucketStart: 60_000, count: 3, sum: 15, max: 9 },
    ]);
    await store.recordRollups([
      { metric: 'request', bucketStart: 60_000, count: 1, sum: 50, max: 50 },
    ]);

    const buckets = await store.queryRollups(['request'], 0, 120_000);
    expect(buckets).toEqual([
      { metric: 'request', bucketStart: 60_000, count: 6, sum: 95, max: 50 },
    ]);
  });

  it('filters by metric set and bucket range', async () => {
    const store = new InMemoryStorageProvider();
    await store.recordRollups([
      { metric: 'request', bucketStart: 0, count: 1, sum: 1, max: 1 },
      { metric: 'request', bucketStart: 60_000, count: 1, sum: 2, max: 2 },
      { metric: 'request', bucketStart: 120_000, count: 1, sum: 3, max: 3 },
      { metric: 'query', bucketStart: 60_000, count: 1, sum: 4, max: 4 },
    ]);

    const inRange = sortBuckets(await store.queryRollups(['request'], 60_000, 120_000));
    expect(inRange).toEqual([
      { metric: 'request', bucketStart: 60_000, count: 1, sum: 2, max: 2 },
      { metric: 'request', bucketStart: 120_000, count: 1, sum: 3, max: 3 },
    ]);

    const multiMetric = sortBuckets(await store.queryRollups(['request', 'query'], 60_000, 60_000));
    expect(multiMetric).toEqual([
      { metric: 'query', bucketStart: 60_000, count: 1, sum: 4, max: 4 },
      { metric: 'request', bucketStart: 60_000, count: 1, sum: 2, max: 2 },
    ]);
  });

  it('returns empty for no metrics / empty store', async () => {
    const store = new InMemoryStorageProvider();
    expect(await store.queryRollups([], 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(await store.queryRollups(['request'], 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
    await store.recordRollups([]);
    expect(await store.queryRollups(['request'], 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it('clears rollups on clear()', async () => {
    const store = new InMemoryStorageProvider();
    await store.recordRollups([{ metric: 'request', bucketStart: 0, count: 1, sum: 1, max: 1 }]);
    await store.clear();
    expect(await store.queryRollups(['request'], 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
  });
});
