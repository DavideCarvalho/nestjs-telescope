import type { Entry } from '@dudousxd/nestjs-telescope';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it } from 'vitest';
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

function newProvider(): RedisStorageProvider {
  return new RedisStorageProvider(new RedisMock() as unknown as Redis);
}

describe('RedisStorageProvider', () => {
  let store: RedisStorageProvider;

  beforeEach(() => {
    store = newProvider();
  });

  it('stores and finds an entry with its batch (createdAt revived as a Date)', async () => {
    await store.store([
      entry({ id: '1', batchId: 'b', sequence: 0 }),
      entry({ id: '2', batchId: 'b', type: 'query', sequence: 1 }),
    ]);

    const found = await store.find('1');
    expect(found?.id).toBe('1');
    expect(found?.createdAt).toBeInstanceOf(Date);
    expect(found?.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(found?.batch.map((event) => event.id)).toEqual(['1', '2']);
  });

  it('returns null for a missing entry', async () => {
    expect(await store.find('nope')).toBeNull();
  });

  it('returns a batch ordered by sequence', async () => {
    await store.store([
      entry({ id: 'c', batchId: 'x', sequence: 2 }),
      entry({ id: 'a', batchId: 'x', sequence: 0 }),
      entry({ id: 'b', batchId: 'x', sequence: 1 }),
    ]);

    const batch = await store.batch('x');
    expect(batch.map((event) => event.id)).toEqual(['a', 'b', 'c']);
    expect(batch.every((event) => event.createdAt instanceof Date)).toBe(true);
  });

  it('counts tags and filters by prefix', async () => {
    await store.store([
      entry({ id: '1', tags: ['queue:default', 'status:200'] }),
      entry({ id: '2', tags: ['queue:default'] }),
      entry({ id: '3', tags: ['queue:emails'] }),
    ]);

    const all = await store.tags();
    expect(new Map(all.map((tagCount) => [tagCount.tag, tagCount.count]))).toEqual(
      new Map([
        ['queue:default', 2],
        ['status:200', 1],
        ['queue:emails', 1],
      ]),
    );

    const queueOnly = await store.tags('queue:');
    expect(new Map(queueOnly.map((tagCount) => [tagCount.tag, tagCount.count]))).toEqual(
      new Map([
        ['queue:default', 2],
        ['queue:emails', 1],
      ]),
    );
  });

  it('clears all data', async () => {
    await store.store([entry({ id: '1', tags: ['x'] })]);
    expect(await store.find('1')).not.toBeNull();

    await store.clear();

    expect(await store.find('1')).toBeNull();
    expect(await store.batch('b')).toEqual([]);
    expect(await store.tags()).toEqual([]);
  });
});
