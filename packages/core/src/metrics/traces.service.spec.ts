import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import type { EntryQuery } from '../storage/storage-provider.js';
import { TracesService } from './traces.service.js';

function entry(type: string, traceId: string | null, createdAt: Date): Entry {
  return {
    id: `${type}-${Math.random()}`,
    batchId: 'b',
    type,
    familyHash: null,
    content: {},
    tags: [],
    sequence: 0,
    durationMs: 5,
    origin: 'http',
    instanceId: 'i',
    traceId,
    spanId: null,
    createdAt,
  };
}

describe('TracesService', () => {
  it('groups windowed entries into distinct traces', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    await storage.store([
      entry('request', 't1', new Date(now - 60_000)),
      entry('query', 't1', new Date(now - 59_000)),
      entry('request', 't2', new Date(now - 40_000)),
      entry('request', 't-old', new Date(now - 600_000)),
    ]);
    const service = new TracesService(storage);
    const result = await service.getTraces({ windowMs: 300_000 });
    expect(result.traces).toHaveLength(2);
    expect(result.traces.map((t) => t.traceId)).toEqual(['t2', 't1']);
    const t1 = result.traces.find((t) => t.traceId === 't1');
    expect(t1?.entryCount).toBe(2);
    expect(t1?.totalDurationMs).toBe(10);
    expect(result.scanned).toBe(3);
  });

  it('applies the limit', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    await storage.store([
      entry('request', 'a', new Date(now - 3000)),
      entry('request', 'b', new Date(now - 2000)),
      entry('request', 'c', new Date(now - 1000)),
    ]);
    const service = new TracesService(storage);
    const result = await service.getTraces({ windowMs: 300_000, limit: 2 });
    expect(result.traces).toHaveLength(2);
    expect(result.traces.map((t) => t.traceId)).toEqual(['c', 'b']);
  });

  it('scans content-less (only traceId/type/createdAt/durationMs needed)', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.store([entry('request', 't1', new Date(Date.now() - 1000))]);
    const getSpy = vi.spyOn(storage, 'get');
    await new TracesService(storage).getTraces({ windowMs: 300_000 });
    expect(getSpy).toHaveBeenCalled();
    for (const call of getSpy.mock.calls) {
      expect((call[0] as EntryQuery).omitContent).toBe(true);
    }
  });

  it('rejects a non-positive window', async () => {
    const service = new TracesService(new InMemoryStorageProvider());
    await expect(service.getTraces({ windowMs: 0 })).rejects.toBeInstanceOf(RangeError);
  });
});
