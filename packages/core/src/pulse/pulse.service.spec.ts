// packages/core/src/pulse/pulse.service.spec.ts
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { SqliteStorageProvider } from '../storage/sqlite-storage-provider.js';
import type { EntryQuery } from '../storage/storage-provider.js';
import { PulseService } from './pulse.service.js';

function entry(type: string, content: unknown, durationMs: number | null, createdAt: Date): Entry {
  return {
    id: `e-${Math.random()}`,
    batchId: 'b',
    type,
    familyHash: type === 'exception' ? 'Error:boom' : null,
    content,
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

describe('PulseService', () => {
  it('summarizes entries within the window from storage', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    await storage.store([
      entry('query', { sql: 'select 1' }, 300, new Date(now - 60_000)),
      entry('request', { uri: '/a', method: 'GET' }, 50, new Date(now - 60_000)),
      entry('exception', { class: 'Error', message: 'boom' }, null, new Date(now - 60_000)),
    ]);
    const service = new PulseService(storage);

    const report = await service.getHealth(3_600_000);

    expect(report.counts).toMatchObject({ query: 1, request: 1, exception: 1 });
    expect(report.slowest[0]!.durationMs).toBe(300);
    expect(report.topExceptions[0]!.count).toBe(1);
    expect(report.scanned).toBe(3);
    expect(report.truncated).toBe(false);
  });

  it('excludes entries older than the window', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    await storage.store([
      entry('query', { sql: 'a' }, 10, new Date(now - 30_000)),
      entry('query', { sql: 'b' }, 10, new Date(now - 600_000)),
    ]);
    const report = await new PulseService(storage).getHealth(60_000);
    expect(report.scanned).toBe(1);
  });

  it('rejects a non-positive window', async () => {
    const service = new PulseService(new InMemoryStorageProvider());
    await expect(service.getHealth(0)).rejects.toBeInstanceOf(RangeError);
    await expect(service.getHealth(-1)).rejects.toBeInstanceOf(RangeError);
  });

  it('scans the window content-less and hydrates only displayed rows', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    // A large content blob on every entry: if the primary scan read it, omit
    // would not be requested. We assert the scan query carries omitContent.
    const bigContent = { sql: 'select 1', blob: 'x'.repeat(5_000) };
    const entries: Entry[] = Array.from({ length: 50 }, (_, i) =>
      entry('query', { ...bigContent }, i + 1, new Date(now - 1_000)),
    );
    await storage.store(entries);

    const getSpy = vi.spyOn(storage, 'get');
    const findSpy = vi.spyOn(storage, 'find');

    const service = new PulseService(storage, { topN: 5 });
    const report = await service.getHealth(60_000);

    // Every primary scan page is content-less.
    expect(getSpy).toHaveBeenCalled();
    for (const call of getSpy.mock.calls) {
      const query = call[0] as EntryQuery;
      expect(query.omitContent).toBe(true);
    }
    // Hydration touches only the few displayed ids (topN slowest here), not all 50.
    expect(findSpy.mock.calls.length).toBeLessThanOrEqual(5);
    // Labels still resolve from hydrated content.
    expect(report.slowest).toHaveLength(5);
    expect(report.slowest[0]!.label).toBe('select 1');
    expect(report.slowest[0]!.durationMs).toBe(50);
  });

  it('produces identical aggregates whether or not the scan omits content (sqlite)', async () => {
    const now = Date.now();
    const seed: Entry[] = [
      entry('query', { sql: 'select * from users where id = ?' }, 320, new Date(now - 1_000)),
      entry('request', { uri: '/a', method: 'GET' }, 90, new Date(now - 1_000)),
      entry('exception', { class: 'TypeError', message: 'boom' }, null, new Date(now - 1_000)),
      // An N+1 family: 6 repeats of one template in one batch.
      ...Array.from({ length: 6 }, () => ({
        ...entry('query', { sql: 'select * from posts where uid = ?' }, 5, new Date(now - 1_000)),
        batchId: 'req-n1',
        familyHash: 'q:posts',
      })),
    ];

    const store = new SqliteStorageProvider({ path: ':memory:' });
    try {
      await store.store(seed);
      const report = await new PulseService(store, {
        topN: 5,
        nPlusOneThreshold: 5,
      }).getHealth(60_000);

      expect(report.counts).toMatchObject({ query: 7, request: 1, exception: 1 });
      // slowest labels hydrated correctly
      expect(report.slowest[0]!.label).toBe('select * from users where id = ?');
      expect(report.slowest.map((s) => s.durationMs)).toEqual([320, 90, 5, 5, 5]);
      // exception class/message hydrated correctly
      expect(report.topExceptions[0]).toMatchObject({
        class: 'TypeError',
        message: 'boom',
        count: 1,
      });
      // N+1 sql hydrated correctly
      expect(report.nPlusOne).toHaveLength(1);
      expect(report.nPlusOne[0]).toMatchObject({
        familyHash: 'q:posts',
        sql: 'select * from posts where uid = ?',
        perRequest: 6,
        requests: 1,
      });
    } finally {
      store.close();
    }
  });
});
