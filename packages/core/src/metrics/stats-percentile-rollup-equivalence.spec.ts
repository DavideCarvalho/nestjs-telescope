import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { aggregateDeltas } from '../rollup/aggregate-deltas.js';
import { LATENCY_BOUNDARIES_MS } from '../rollup/rollup-store.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import type {
  EntryQuery,
  EntryWithBatch,
  Page,
  StorageProvider,
  TagCount,
} from '../storage/storage-provider.js';
import { StatsService } from './stats.service.js';

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

/** Wraps an InMemoryStorageProvider but HIDES the RollupStore SPI, forcing the
 *  raw-scan percentile path (exactly the equivalence spec for timeseries does). */
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

/** The widest boundary gap up to value `v`'s bucket — the worst-case tolerance
 *  for a bucket-resolution percentile estimate of `v`. */
function bucketWidthAround(value: number): number {
  let previous = 0;
  for (const boundary of LATENCY_BOUNDARIES_MS) {
    if (value <= boundary) return boundary - previous;
    previous = boundary;
  }
  const last = LATENCY_BOUNDARIES_MS[LATENCY_BOUNDARIES_MS.length - 1] ?? 0;
  const secondLast = LATENCY_BOUNDARIES_MS[LATENCY_BOUNDARIES_MS.length - 2] ?? 0;
  return last - secondLast;
}

/**
 * Equivalence proof for the STATS percentiles: the same seeded entries fed
 * through the raw-scan path (sort every durationMs) and the rollup-histogram
 * path MUST agree on p50/p95/p99 within one bucket-width. The rollup estimate is
 * a bucket-resolution approximation, so exact equality is not expected — the
 * tolerance is the bucket gap (mirrors estimate-percentile's accuracy gate).
 */
describe('stats percentile rollup/raw-scan equivalence', () => {
  async function buildBoth(entries: Entry[]): Promise<{ raw: StatsService; rollup: StatsService }> {
    const rollupBacking = new InMemoryStorageProvider();
    await rollupBacking.store(entries);
    await rollupBacking.recordRollups(aggregateDeltas(entries));

    const rawBacking = new InMemoryStorageProvider();
    await rawBacking.store(entries);

    return {
      raw: new StatsService(rawScanStorage(rawBacking)),
      rollup: new StatsService(rollupBacking),
    };
  }

  it('agrees on p50/p95/p99 within one bucket-width over a window', async () => {
    const now = Date.now();
    const entries: Entry[] = [];
    // 300 request samples spread across many latency buckets, all within the window.
    for (let i = 0; i < 300; i += 1) {
      const duration = ((i * 53) % 4000) + 1; // 1..4000
      entries.push(entry('request', new Date(now - (i % 50) * 1000), duration));
    }

    const { raw, rollup } = await buildBoth(entries);
    const rawStats = await raw.getStats({ type: 'request', windowMs: 120_000, buckets: 2 });
    const rollupStats = await rollup.getStats({ type: 'request', windowMs: 120_000, buckets: 2 });

    expect(rawStats.latency).toBeDefined();
    expect(rollupStats.latency).toBeDefined();
    const rawLatency = rawStats.latency;
    const rollupLatency = rollupStats.latency;
    if (rawLatency === undefined || rollupLatency === undefined) throw new Error('no latency');

    // count/max/slow are still raw-derived and must match exactly.
    expect(rollupLatency.count).toBe(rawLatency.count);
    expect(rollupLatency.max).toBe(rawLatency.max);
    expect(rollupLatency.slow).toBe(rawLatency.slow);

    // Percentiles agree within the bucket tolerance.
    expect(Math.abs(rollupLatency.p50 - rawLatency.p50)).toBeLessThanOrEqual(
      bucketWidthAround(rawLatency.p50),
    );
    expect(Math.abs(rollupLatency.p95 - rawLatency.p95)).toBeLessThanOrEqual(
      bucketWidthAround(rawLatency.p95),
    );
    expect(Math.abs(rollupLatency.p99 - rawLatency.p99)).toBeLessThanOrEqual(
      bucketWidthAround(rawLatency.p99),
    );
  });

  it('leaves latency absent when there are no durationMs samples (shape parity)', async () => {
    const now = Date.now();
    const entries = [
      entry('request', new Date(now - 5_000), null),
      entry('request', new Date(now - 4_000), null),
    ];
    const { raw, rollup } = await buildBoth(entries);

    const rawStats = await raw.getStats({ type: 'request', windowMs: 60_000, buckets: 1 });
    const rollupStats = await rollup.getStats({ type: 'request', windowMs: 60_000, buckets: 1 });

    // No durations ⇒ no latency block on EITHER path (the rollup override must
    // not synthesize one).
    expect(rawStats.latency).toBeUndefined();
    expect(rollupStats.latency).toBeUndefined();
  });
});
