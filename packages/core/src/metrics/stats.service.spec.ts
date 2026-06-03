import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { StatsService } from './stats.service.js';

function queryEntry(createdAt: Date, durationMs: number, familyHash: string): Entry {
  return {
    id: `query-${Math.random()}`,
    batchId: 'b',
    type: 'query',
    familyHash,
    content: { sql: 'select 1', bindings: [], connection: null, slow: false },
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

function cacheEntry(createdAt: Date, operation: 'get' | 'set', hit: boolean | null): Entry {
  return {
    id: `cache-${Math.random()}`,
    batchId: 'b',
    type: 'cache',
    familyHash: null,
    content: { operation, key: 'user:1', hit },
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt,
  };
}

describe('StatsService', () => {
  it('returns latency + families for the query type', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    await storage.store([
      queryEntry(new Date(now - 1000), 10, 'fam-a'),
      queryEntry(new Date(now - 2000), 40, 'fam-a'),
      queryEntry(new Date(now - 3000), 200, 'fam-b'),
    ]);
    const service = new StatsService(storage);
    const result = await service.getStats({ type: 'query', windowMs: 300_000 });

    expect(result.type).toBe('query');
    expect(result.total).toBe(3);
    expect(result.latency?.count).toBe(3);
    expect(result.families).toBeDefined();
    expect(result.families?.length).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('returns cache stats for the cache type', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    await storage.store([
      cacheEntry(new Date(now - 1000), 'get', true),
      cacheEntry(new Date(now - 2000), 'get', false),
      cacheEntry(new Date(now - 3000), 'set', null),
    ]);
    const service = new StatsService(storage);
    const result = await service.getStats({ type: 'cache', windowMs: 300_000 });

    expect(result.type).toBe('cache');
    expect(result.cache).toBeDefined();
    expect(result.cache?.hits).toBe(1);
    expect(result.cache?.misses).toBe(1);
    expect(result.cache?.sets).toBe(1);
    expect(result.cache?.hitRatio).toBeCloseTo(0.5);
  });

  it('respects the slowMs option when counting slow entries', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    await storage.store([
      queryEntry(new Date(now - 1000), 10, 'fam-a'),
      queryEntry(new Date(now - 2000), 500, 'fam-a'),
    ]);
    const service = new StatsService(storage, { slowMs: 100 });
    const result = await service.getStats({ type: 'query', windowMs: 300_000 });
    expect(result.latency?.slow).toBe(1);
  });

  it('rejects a non-positive window', async () => {
    const service = new StatsService(new InMemoryStorageProvider());
    await expect(service.getStats({ type: 'query', windowMs: 0 })).rejects.toBeInstanceOf(
      RangeError,
    );
  });

  it('flags truncated when the scan hits the cap', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    await storage.store([
      queryEntry(new Date(now - 1000), 10, 'fam-a'),
      queryEntry(new Date(now - 2000), 20, 'fam-a'),
      queryEntry(new Date(now - 3000), 30, 'fam-a'),
    ]);
    const service = new StatsService(storage, { pageSize: 1, scanCap: 2 });
    const result = await service.getStats({ type: 'query', windowMs: 300_000 });
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(2);
  });
});
