import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import type { EntryQuery } from '../storage/storage-provider.js';
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

describe('TimeseriesService', () => {
  it('buckets windowed entries from storage', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    await storage.store([
      entry('request', new Date(now - 60_000)),
      entry('query', new Date(now - 50_000)),
      entry('request', new Date(now - 600_000)),
    ]);
    const service = new TimeseriesService(storage);
    const report = await service.getTimeseries({ windowMs: 300_000, buckets: 5 });
    const total = report.buckets.reduce((sum, bucket) => sum + bucket.total, 0);
    expect(total).toBe(2);
    expect(report.scanned).toBe(2);
    expect(report.buckets).toHaveLength(5);
  });

  it('applies a tag filter (per-queue series)', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    await storage.store([
      entry('job', new Date(now - 1000)),
      entry('request', new Date(now - 1000)),
    ]);
    const service = new TimeseriesService(storage);
    const report = await service.getTimeseries({
      windowMs: 300_000,
      buckets: 5,
      tag: 'queue:mail',
    });
    expect(report.scanned).toBe(1);
  });

  it('scans content-less (bucketing needs only createdAt + type)', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.store([entry('request', new Date(Date.now() - 1_000))]);
    const getSpy = vi.spyOn(storage, 'get');
    await new TimeseriesService(storage).getTimeseries({ windowMs: 300_000, buckets: 5 });
    expect(getSpy).toHaveBeenCalled();
    for (const call of getSpy.mock.calls) {
      expect((call[0] as EntryQuery).omitContent).toBe(true);
    }
  });

  it('rejects a non-positive window', async () => {
    const service = new TimeseriesService(new InMemoryStorageProvider());
    await expect(service.getTimeseries({ windowMs: 0, buckets: 5 })).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});
