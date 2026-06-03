import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
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
import { TimeseriesService } from './timeseries.service.js';

function entry(type: string, createdAt: Date): Entry {
  return {
    id: `${type}-${Math.random()}`,
    batchId: 'b',
    type,
    familyHash: null,
    content: {},
    tags: type === 'job' ? ['queue:mail'] : [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt,
  };
}

/** Stores entries AND records the matching rollups, mirroring the Recorder's flush. */
async function seed(storage: InMemoryStorageProvider, entries: Entry[]): Promise<void> {
  await storage.store(entries);
  await storage.recordRollups(aggregateDeltas(entries));
}

/**
 * A raw-scan-only storage: it does NOT implement RollupStore, so the service
 * keeps the entry-scan path. Backed by an InMemoryStorageProvider for behavior.
 */
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

describe('TimeseriesService', () => {
  it('buckets windowed entries from storage (rollup-backed)', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    await seed(storage, [
      entry('request', new Date(now - 60_000)),
      entry('query', new Date(now - 50_000)),
      entry('request', new Date(now - 600_000)), // outside the 300s window
    ]);
    const service = new TimeseriesService(storage);
    const report = await service.getTimeseries({ windowMs: 300_000, buckets: 5 });
    const total = report.buckets.reduce((sum, bucket) => sum + bucket.total, 0);
    expect(total).toBe(2);
    expect(report.buckets).toHaveLength(5);
  });

  it('applies a tag filter via the raw-scan path (rollups ignore tags)', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    await seed(storage, [
      entry('job', new Date(now - 1000)),
      entry('request', new Date(now - 1000)),
    ]);
    const service = new TimeseriesService(storage);
    const report = await service.getTimeseries({
      windowMs: 300_000,
      buckets: 5,
      tag: 'queue:mail',
    });
    // A tag filter forces the raw scan (rollups aggregate across tags).
    expect(report.scanned).toBe(1);
  });

  it('scans content-less on the raw-scan path (non-rollup storage)', async () => {
    const backing = new InMemoryStorageProvider();
    await backing.store([entry('request', new Date(Date.now() - 1_000))]);
    const storage = rawScanStorage(backing);
    const getSpy = vi.spyOn(storage, 'get');
    await new TimeseriesService(storage).getTimeseries({ windowMs: 300_000, buckets: 5 });
    expect(getSpy).toHaveBeenCalled();
    for (const call of getSpy.mock.calls) {
      const entryQuery: EntryQuery = call[0];
      expect(entryQuery.omitContent).toBe(true);
    }
  });

  it('rejects a non-positive window', async () => {
    const service = new TimeseriesService(new InMemoryStorageProvider());
    await expect(service.getTimeseries({ windowMs: 0, buckets: 5 })).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});
