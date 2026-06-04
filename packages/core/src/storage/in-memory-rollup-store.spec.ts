import { describe, expect, it } from 'vitest';
import type { RollupBucket, RollupDelta } from '../rollup/rollup-store.js';
import { emptyHistogram, incrementHistogram, isRollupStore } from '../rollup/rollup-store.js';
import { InMemoryStorageProvider } from './in-memory-storage-provider.js';

function sortBuckets(buckets: RollupBucket[]): RollupBucket[] {
  return [...buckets].sort(
    (a, b) => a.metric.localeCompare(b.metric) || a.bucketStart - b.bucketStart,
  );
}

/** A histogram with a single sample in the cell for `durationMs`. */
function histogramAt(durationMs: number): number[] {
  const histogram = emptyHistogram();
  incrementHistogram(histogram, durationMs);
  return histogram;
}

function delta(overrides: Partial<RollupDelta> = {}): RollupDelta {
  return {
    metric: 'request',
    bucketStart: 60_000,
    count: 1,
    sum: 10,
    max: 10,
    histogram: histogramAt(10),
    ...overrides,
  };
}

describe('InMemoryStorageProvider RollupStore', () => {
  it('is detected as a rollup store', () => {
    expect(isRollupStore(new InMemoryStorageProvider())).toBe(true);
  });

  it('accumulates count/sum, keeps a running max, and merges histograms element-wise', async () => {
    const store = new InMemoryStorageProvider();
    await store.recordRollups([delta({ count: 2, sum: 30, max: 20, histogram: histogramAt(20) })]);
    await store.recordRollups([delta({ count: 3, sum: 15, max: 9, histogram: histogramAt(9) })]);
    await store.recordRollups([delta({ count: 1, sum: 50, max: 50, histogram: histogramAt(50) })]);

    const expectedHistogram = emptyHistogram();
    incrementHistogram(expectedHistogram, 20);
    incrementHistogram(expectedHistogram, 9);
    incrementHistogram(expectedHistogram, 50);

    const buckets = await store.queryRollups(['request'], 0, 120_000);
    expect(buckets).toEqual([
      {
        metric: 'request',
        bucketStart: 60_000,
        count: 6,
        sum: 95,
        max: 50,
        histogram: expectedHistogram,
      },
    ]);
  });

  it('filters by metric set and bucket range', async () => {
    const store = new InMemoryStorageProvider();
    await store.recordRollups([
      delta({ metric: 'request', bucketStart: 0, count: 1, sum: 1, max: 1 }),
      delta({ metric: 'request', bucketStart: 60_000, count: 1, sum: 2, max: 2 }),
      delta({ metric: 'request', bucketStart: 120_000, count: 1, sum: 3, max: 3 }),
      delta({ metric: 'query', bucketStart: 60_000, count: 1, sum: 4, max: 4 }),
    ]);

    const inRange = sortBuckets(await store.queryRollups(['request'], 60_000, 120_000));
    expect(inRange.map((bucket) => `${bucket.metric}@${bucket.bucketStart}`)).toEqual([
      'request@60000',
      'request@120000',
    ]);

    const multiMetric = sortBuckets(await store.queryRollups(['request', 'query'], 60_000, 60_000));
    expect(multiMetric.map((bucket) => bucket.metric)).toEqual(['query', 'request']);
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
    await store.recordRollups([delta()]);
    await store.clear();
    expect(await store.queryRollups(['request'], 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
  });
});
