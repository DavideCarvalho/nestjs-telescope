import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { RollupBucket, RollupDelta } from '../rollup/rollup-store.js';
import { emptyHistogram, incrementHistogram, isRollupStore } from '../rollup/rollup-store.js';
import { SqliteStorageProvider } from './sqlite-storage-provider.js';

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

describe('SqliteStorageProvider RollupStore', () => {
  let store: SqliteStorageProvider;

  afterEach(() => {
    store?.close();
  });

  it('is detected as a rollup store', () => {
    store = new SqliteStorageProvider();
    expect(isRollupStore(store)).toBe(true);
  });

  it('accumulates count/sum, keeps a running max, and merges histograms via upsert', async () => {
    store = new SqliteStorageProvider();
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

  it('merges histograms within a single multi-delta batch hitting the same bucket', async () => {
    store = new SqliteStorageProvider();
    await store.recordRollups([
      delta({ count: 1, sum: 5, max: 5, histogram: histogramAt(5) }),
      delta({ count: 1, sum: 250, max: 250, histogram: histogramAt(250) }),
    ]);

    const expectedHistogram = emptyHistogram();
    incrementHistogram(expectedHistogram, 5);
    incrementHistogram(expectedHistogram, 250);

    const buckets = await store.queryRollups(['request'], 60_000, 60_000);
    expect(buckets[0]?.histogram).toEqual(expectedHistogram);
    expect(buckets[0]?.count).toBe(2);
  });

  it('filters by metric set and bucket range', async () => {
    store = new SqliteStorageProvider();
    await store.recordRollups([
      delta({ metric: 'request', bucketStart: 0, count: 1, sum: 1, max: 1 }),
      delta({ metric: 'request', bucketStart: 60_000, count: 1, sum: 2, max: 2 }),
      delta({ metric: 'request', bucketStart: 120_000, count: 1, sum: 3, max: 3 }),
      delta({ metric: 'query', bucketStart: 60_000, count: 1, sum: 4, max: 4 }),
    ]);

    const inRange = sortBuckets(await store.queryRollups(['request'], 60_000, 120_000));
    expect(inRange.map((bucket) => bucket.bucketStart)).toEqual([60_000, 120_000]);

    const multiMetric = sortBuckets(await store.queryRollups(['request', 'query'], 60_000, 60_000));
    expect(multiMetric.map((bucket) => bucket.metric)).toEqual(['query', 'request']);
  });

  it('returns empty for no metrics / empty store / empty deltas', async () => {
    store = new SqliteStorageProvider();
    expect(await store.queryRollups([], 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(await store.queryRollups(['request'], 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
    await store.recordRollups([]);
    expect(await store.queryRollups(['request'], 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it('clears rollups on clear()', async () => {
    store = new SqliteStorageProvider();
    await store.recordRollups([delta()]);
    await store.clear();
    expect(await store.queryRollups(['request'], 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
  });
});

describe('SqliteStorageProvider legacy rollup histogram self-heal (file db)', () => {
  it('adds histogram to a legacy table and reads legacy rows as zeros, then merges', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dir = mkdtempSync(join(tmpdir(), 'telescope-sqlite-rollup-'));
    const dbPath = join(dir, 'legacy.sqlite');
    let provider: SqliteStorageProvider | null = null;
    try {
      const legacyDb = new Database(dbPath);
      legacyDb.exec(
        `create table telescope_rollups (
           metric text not null,
           bucket_start integer not null,
           count integer not null,
           sum integer not null,
           max integer not null,
           primary key (metric, bucket_start)
         );
         insert into telescope_rollups (metric, bucket_start, count, sum, max)
           values ('request', 60000, 3, 30, 15);`,
      );
      legacyDb.close();

      provider = new SqliteStorageProvider({ path: dbPath });

      // Legacy row reads back with an all-zeros histogram of the canonical length.
      const legacy = await provider.queryRollups(['request'], 60_000, 60_000);
      expect(legacy).toEqual([
        {
          metric: 'request',
          bucketStart: 60_000,
          count: 3,
          sum: 30,
          max: 15,
          histogram: emptyHistogram(),
        },
      ]);

      // A subsequent record merges a real histogram onto the (zero) base.
      await provider.recordRollups([
        delta({ count: 1, sum: 5, max: 25, histogram: histogramAt(25) }),
      ]);
      const merged = await provider.queryRollups(['request'], 60_000, 60_000);
      expect(merged[0]?.count).toBe(4);
      expect(merged[0]?.max).toBe(25);
      expect(merged[0]?.histogram).toEqual(histogramAt(25));
    } finally {
      provider?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
