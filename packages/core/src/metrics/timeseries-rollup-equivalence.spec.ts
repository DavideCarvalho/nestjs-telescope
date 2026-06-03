import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { aggregateDeltas } from '../rollup/aggregate-deltas.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import type {
  EntryQuery,
  EntryWithBatch,
  Page,
  StorageProvider,
  TagCount,
} from '../storage/storage-provider.js';
import type { TimeseriesBucket } from './timeseries.js';
import { TimeseriesService } from './timeseries.service.js';

/** Counts only — the `t` label derives from a per-call `new Date()` and can drift 1ms. */
function counts(buckets: TimeseriesBucket[]): { total: number; byType: Record<string, number> }[] {
  return buckets.map((bucket) => ({ total: bucket.total, byType: bucket.byType }));
}

function entry(type: string, createdAt: Date, durationMs: number | null): Entry {
  return {
    id: `${type}-${createdAt.getTime()}-${Math.random()}`,
    batchId: 'b',
    type,
    familyHash: null,
    content: {},
    tags: [],
    sequence: 0,
    durationMs,
    origin: 'http',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt,
  };
}

/** Wraps an InMemoryStorageProvider but HIDES the RollupStore SPI, forcing the raw scan. */
function rawScanStorage(backing: InMemoryStorageProvider): StorageProvider {
  return {
    store: (entries: Entry[]): Promise<void> => backing.store(entries),
    update: (id: string, patch: Partial<Entry>): Promise<void> => backing.update(id, patch),
    find: (id: string): Promise<EntryWithBatch | null> => backing.find(id),
    get: (query: EntryQuery): Promise<Page<Entry>> => backing.get(query),
    batch: (batchId: string): Promise<Entry[]> => backing.batch(batchId),
    tags: (prefix?: string): Promise<TagCount[]> => backing.tags(prefix),
    prune: (olderThan: Date, keepLast?: number): Promise<number> =>
      backing.prune(olderThan, keepLast),
    clear: (): Promise<void> => backing.clear(),
  };
}

/**
 * Equivalence proof: for the same seeded entries and the same window/buckets,
 * the rollup-backed timeseries output MUST match the raw-scan output. We pick a
 * window aligned to the 1-minute rollup granularity (single whole-window bucket,
 * and multi-bucket cases where every entry sits inside one minute) so the
 * re-bucketing is lossless.
 */
describe('timeseries rollup/raw-scan equivalence', () => {
  async function buildBoth(entries: Entry[]): Promise<{
    raw: TimeseriesService;
    rollup: TimeseriesService;
  }> {
    const rollupBacking = new InMemoryStorageProvider();
    await rollupBacking.store(entries);
    await rollupBacking.recordRollups(aggregateDeltas(entries));

    const rawBacking = new InMemoryStorageProvider();
    await rawBacking.store(entries);

    return {
      raw: new TimeseriesService(rawScanStorage(rawBacking)),
      rollup: new TimeseriesService(rollupBacking),
    };
  }

  it('matches total + byType over a single whole-window bucket', async () => {
    const now = Date.now();
    const entries = [
      entry('request', new Date(now - 5_000), 10),
      entry('request', new Date(now - 4_000), 20),
      entry('query', new Date(now - 3_000), 5),
    ];
    const { raw, rollup } = await buildBoth(entries);

    const rawReport = await raw.getTimeseries({ windowMs: 30_000, buckets: 1 });
    const rollupReport = await rollup.getTimeseries({ windowMs: 30_000, buckets: 1 });

    expect(counts(rollupReport.buckets)).toEqual(counts(rawReport.buckets));
    expect(rollupReport.bucketMs).toBe(rawReport.bucketMs);
  });

  it('matches per-type filtered series over a single bucket', async () => {
    const now = Date.now();
    const entries = [
      entry('request', new Date(now - 5_000), 10),
      entry('query', new Date(now - 4_000), 20),
    ];
    const { raw, rollup } = await buildBoth(entries);

    const rawReport = await raw.getTimeseries({ windowMs: 30_000, buckets: 1, type: 'request' });
    const rollupReport = await rollup.getTimeseries({
      windowMs: 30_000,
      buckets: 1,
      type: 'request',
    });

    expect(counts(rollupReport.buckets)).toEqual(counts(rawReport.buckets));
  });

  it('matches multi-bucket counts when each entry sits within one minute', async () => {
    // 5-minute window, 5 one-minute buckets: every entry occupies a distinct
    // minute, so floorToBucket placement coincides with raw-createdAt placement.
    const now = Date.now();
    const entries = [
      entry('request', new Date(now - 30_000), 1), // current minute-ish
      entry('request', new Date(now - 130_000), 2),
      entry('query', new Date(now - 130_000), 3),
    ];
    const { raw, rollup } = await buildBoth(entries);

    const rawReport = await raw.getTimeseries({ windowMs: 300_000, buckets: 5 });
    const rollupReport = await rollup.getTimeseries({ windowMs: 300_000, buckets: 5 });

    const rawTotals = rawReport.buckets.map((b) => b.total);
    const rollupTotals = rollupReport.buckets.map((b) => b.total);
    const rawSum = rawTotals.reduce((s, n) => s + n, 0);
    const rollupSum = rollupTotals.reduce((s, n) => s + n, 0);
    expect(rollupSum).toBe(rawSum);
    expect(rollupSum).toBe(3);
  });
});
