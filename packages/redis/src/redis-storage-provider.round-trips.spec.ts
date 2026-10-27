import { type Entry, emptyHistogram } from '@dudousxd/nestjs-telescope';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisStorageProvider } from './redis-storage-provider.js';

function entry(over: Partial<Entry>): Entry {
  return {
    id: 'id',
    batchId: 'b',
    type: 'request',
    familyHash: null,
    content: { body: 'x'.repeat(500) },
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

const COMMANDS = ['get', 'mget', 'set', 'hgetall', 'zrangebyscore', 'zrangebylex', 'eval'] as const;

/**
 * Counts client round trips: each command sent on its own is one, and each
 * pipeline/MULTI is one however many commands it carries. Also records the keys
 * every MGET asked for.
 */
function countRoundTrips(redis: Redis) {
  const counter = { trips: 0, mgetKeys: [] as string[], lexIndexes: [] as string[] };
  for (const command of COMMANDS) {
    const original = (redis[command] as (...args: unknown[]) => unknown).bind(redis);
    vi.spyOn(redis, command).mockImplementation(((...args: unknown[]) => {
      counter.trips += 1;
      if (command === 'mget') counter.mgetKeys.push(...(args as string[]));
      if (command === 'zrangebylex') counter.lexIndexes.push(args[0] as string);
      return original(...args);
    }) as never);
  }
  for (const batching of ['pipeline', 'multi'] as const) {
    const original = (redis[batching] as (...args: unknown[]) => { exec: () => unknown }).bind(
      redis,
    );
    vi.spyOn(redis, batching).mockImplementation(((...args: unknown[]) => {
      const batch = original(...args);
      const exec = batch.exec.bind(batch);
      batch.exec = () => {
        counter.trips += 1;
        return exec();
      };
      return batch;
    }) as never);
  }
  return counter;
}

describe('RedisStorageProvider round trips', () => {
  let redis: Redis;
  let store: RedisStorageProvider;

  beforeEach(async () => {
    redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
    store = new RedisStorageProvider(redis);
  });

  it('reads every rollup bucket of every metric in two pipelined round trips', async () => {
    const deltas = ['request', 'query', 'cache'].flatMap((metric) =>
      Array.from({ length: 60 }, (_, minute) => ({
        metric,
        bucketStart: minute * 60_000,
        count: 1,
        sum: minute,
        max: minute,
        histogram: emptyHistogram(),
      })),
    );
    await store.recordRollups(deltas);
    const counter = countRoundTrips(redis);

    const rows = await store.queryRollups(['request', 'query', 'cache'], 0, 59 * 60_000);

    expect(rows).toHaveLength(180);
    expect(rows.find((row) => row.metric === 'query' && row.bucketStart === 120_000)).toMatchObject(
      { count: 1, sum: 2, max: 2 },
    );
    expect(counter.trips).toBe(2);
  });

  it('serves content-less pages without reading the full entry blobs', async () => {
    await store.store([
      entry({ id: 'a', createdAt: new Date(1_000), durationMs: 5, tags: ['t'] }),
      entry({ id: 'b', createdAt: new Date(2_000), durationMs: 7 }),
    ]);
    const counter = countRoundTrips(redis);

    const page = await store.get({ type: 'request', omitContent: true });
    const byIds = await store.get({ ids: ['a'], omitContent: true });

    expect(page.data.map((e) => [e.id, e.durationMs, e.content, e.tags])).toEqual([
      ['b', 7, null, []],
      ['a', 5, null, ['t']],
    ]);
    expect(byIds.data.map((e) => e.id)).toEqual(['a']);
    expect(counter.mgetKeys.some((key) => key.startsWith('telescope:e:'))).toBe(false);
  });

  it('falls back to the full entry for entries that have no content-less copy', async () => {
    await store.store([entry({ id: 'old', createdAt: new Date(1_000), durationMs: 3 })]);
    await redis.del('telescope:m:old');

    const page = await store.get({ omitContent: true });

    expect(page.data.map((e) => [e.id, e.durationMs, e.content])).toEqual([['old', 3, null]]);
  });

  it('keeps the content-less copy in step with update()', async () => {
    await store.store([entry({ id: 'a', createdAt: new Date(1_000), durationMs: null })]);
    await store.update('a', { durationMs: 42 });

    const page = await store.get({ omitContent: true });

    expect(page.data[0]?.durationMs).toBe(42);
  });

  it('pages a {type, familyHash} query over the family index', async () => {
    await store.store([
      entry({ id: 'a', type: 'query', familyHash: 'fam', createdAt: new Date(1_000) }),
      entry({ id: 'b', type: 'query', familyHash: 'other', createdAt: new Date(2_000) }),
    ]);
    const counter = countRoundTrips(redis);

    const page = await store.get({ type: 'query', familyHash: 'fam' });

    expect(page.data.map((e) => e.id)).toEqual(['a']);
    expect(counter.lexIndexes).toEqual(['telescope:idx:family:fam']);
  });

  it('drops a tag from the tag-count hash once no entry carries it', async () => {
    await store.store([
      entry({ id: 'a', createdAt: new Date(1_000), tags: ['gone', 'kept'] }),
      entry({ id: 'b', createdAt: new Date(5_000), tags: ['kept'] }),
    ]);

    await store.prune(new Date(2_000));

    expect(await redis.hgetall('telescope:tags')).toEqual({ kept: '1' });
    expect(await store.tags()).toEqual([{ tag: 'kept', count: 1 }]);
    expect(await redis.exists('telescope:m:a')).toBe(0);
  });
});
