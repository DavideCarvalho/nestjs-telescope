import type { Entry } from '@dudousxd/nestjs-telescope';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RedisStorageProvider } from './redis-storage-provider.js';

function entry(over: Partial<Entry>): Entry {
  return {
    id: 'id',
    batchId: 'b',
    type: 'request',
    familyHash: null,
    content: {},
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'i',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

// Opt-in parity check against a REAL Redis server. Skipped (0 failures) unless
// REDIS_URL is set — proves ioredis-mock behaves like the real client.
describe.skipIf(!process.env.REDIS_URL)('RedisStorageProvider (real Redis)', () => {
  let redis: Redis;
  let store: RedisStorageProvider;

  beforeAll(async () => {
    const Redis = (await import('ioredis')).default;
    redis = new Redis(process.env.REDIS_URL!);
  });

  beforeEach(async () => {
    await redis.flushdb();
    store = new RedisStorageProvider(redis);
  });

  afterAll(async () => {
    await redis.flushdb();
    await redis.quit();
  });

  it('stores and finds an entry with its batch', async () => {
    await store.store([
      entry({ id: '1', batchId: 'b', sequence: 0 }),
      entry({ id: '2', batchId: 'b', sequence: 1 }),
    ]);

    const found = await store.find('1');
    expect(found?.id).toBe('1');
    expect(found?.createdAt).toBeInstanceOf(Date);
    expect(found?.batch.map((event) => event.id)).toEqual(['1', '2']);
  });

  it('returns entries newest-first via get', async () => {
    const base = Date.parse('2026-01-01T00:00:00Z');
    await store.store([
      entry({ id: 'old', createdAt: new Date(base) }),
      entry({ id: 'mid', createdAt: new Date(base + 1000) }),
      entry({ id: 'new', createdAt: new Date(base + 2000) }),
    ]);

    const page = await store.get({});
    expect(page.data.map((event) => event.id)).toEqual(['new', 'mid', 'old']);
  });

  it('prunes entries older than the cutoff', async () => {
    const base = Date.parse('2026-01-01T00:00:00Z');
    await store.store([
      entry({ id: 'old', createdAt: new Date(base) }),
      entry({ id: 'fresh', createdAt: new Date(base + 10_000) }),
    ]);

    const removed = await store.prune(new Date(base + 5000));
    expect(removed).toBe(1);
    expect(await store.find('old')).toBeNull();
    expect(await store.find('fresh')).not.toBeNull();
  });
});
