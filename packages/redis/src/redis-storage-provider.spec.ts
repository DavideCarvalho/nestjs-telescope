import { type Entry, isRollupStore } from '@dudousxd/nestjs-telescope';
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
    traceId: null,
    spanId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

describe('RedisStorageProvider', () => {
  let store: RedisStorageProvider;

  beforeEach(async () => {
    // ioredis-mock instances share one in-process datastore, so flush before
    // each test to keep them isolated (fresh store per test).
    const redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
    store = new RedisStorageProvider(redis);
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

  it('omitContent nulls content after parse (no projection benefit on redis)', async () => {
    await store.store([
      entry({ id: '1', type: 'query', durationMs: 9, content: { sql: 'select 1' } }),
    ]);
    const { data } = await store.get({ omitContent: true });
    expect(data).toHaveLength(1);
    expect(data[0]!.content).toBeNull();
    expect(data[0]!.id).toBe('1');
    expect(data[0]!.durationMs).toBe(9);
  });

  it('round-trips traceId/spanId through store → find', async () => {
    await store.store([
      entry({ id: 'traced', batchId: 'tb', traceId: 't', spanId: 's' }),
      entry({ id: 'untraced', batchId: 'ub', traceId: null, spanId: null }),
    ]);

    const traced = await store.find('traced');
    expect(traced?.traceId).toBe('t');
    expect(traced?.spanId).toBe('s');

    const untraced = await store.find('untraced');
    expect(untraced?.traceId).toBeNull();
    expect(untraced?.spanId).toBeNull();
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

  it('paginates newest-first via cursor with no dupes (120 entries, limit 50)', async () => {
    const base = Date.parse('2026-01-01T00:00:00Z');
    const entries = Array.from({ length: 120 }, (_, i) =>
      entry({ id: `e${i}`, batchId: `b${i}`, createdAt: new Date(base + i * 1000) }),
    );
    await store.store(entries);

    const collected: Entry[] = [];
    const pageSizes: number[] = [];
    let cursor: string | null | undefined;
    let pages = 0;
    do {
      const page = await store.get({ limit: 50, cursor: cursor ?? undefined });
      pageSizes.push(page.data.length);
      collected.push(...page.data);
      cursor = page.nextCursor;
      pages++;
      expect(pages).toBeLessThanOrEqual(10);
    } while (cursor !== null);

    expect(pages).toBe(3);
    expect(pageSizes).toEqual([50, 50, 20]);
    expect(collected).toHaveLength(120);

    // No duplicate ids.
    expect(new Set(collected.map((e) => e.id)).size).toBe(120);

    // Newest-first: createdAt strictly descending across the whole concatenation.
    for (let i = 1; i < collected.length; i++) {
      expect(collected[i - 1].createdAt.getTime()).toBeGreaterThan(
        collected[i].createdAt.getTime(),
      );
    }
    // Newest entry first, oldest last.
    expect(collected[0].id).toBe('e119');
    expect(collected.at(-1)?.id).toBe('e0');
  });

  it('filters by type', async () => {
    const base = Date.parse('2026-01-01T00:00:00Z');
    await store.store([
      entry({ id: '1', type: 'query', createdAt: new Date(base + 1000) }),
      entry({ id: '2', type: 'request', createdAt: new Date(base + 2000) }),
      entry({ id: '3', type: 'query', createdAt: new Date(base + 3000) }),
      entry({ id: '4', type: 'request', createdAt: new Date(base + 4000) }),
    ]);

    const page = await store.get({ type: 'query' });
    expect(page.data.map((e) => e.id)).toEqual(['3', '1']);
    expect(page.data.every((e) => e.type === 'query')).toBe(true);
  });

  it('fetches an ids set in one MGET (AND with type; empty/absent ids)', async () => {
    const base = Date.parse('2026-01-01T00:00:00Z');
    await store.store([
      entry({ id: 'a', batchId: 'ba', type: 'query', createdAt: new Date(base + 1000) }),
      entry({ id: 'b', batchId: 'bb', type: 'request', createdAt: new Date(base + 2000) }),
      entry({ id: 'c', batchId: 'bc', type: 'query', createdAt: new Date(base + 3000) }),
    ]);

    // Exactly the requested ids, with content, newest-first.
    const byIds = await store.get({ ids: ['a', 'c'] });
    expect(byIds.data.map((e) => e.id)).toEqual(['c', 'a']);
    expect(byIds.data.every((e) => e.content !== null)).toBe(true);

    // ANDs with another filter.
    const byIdsAndType = await store.get({ ids: ['a', 'b', 'c'], type: 'query' });
    expect(byIdsAndType.data.map((e) => e.id)).toEqual(['c', 'a']);

    // An id not present is simply absent.
    const withMissing = await store.get({ ids: ['a', 'missing'] });
    expect(withMissing.data.map((e) => e.id)).toEqual(['a']);

    // Empty array returns no entries.
    expect((await store.get({ ids: [] })).data).toEqual([]);
  });

  it('free-text searches content (case-insensitive substring), ANDing with type', async () => {
    const base = Date.parse('2026-01-01T00:00:00Z');
    await store.store([
      entry({
        id: 'req',
        batchId: 'br',
        type: 'request',
        content: { uri: '/api/orders' },
        createdAt: new Date(base + 1000),
      }),
      entry({
        id: 'sql',
        batchId: 'bs',
        type: 'query',
        content: { sql: 'select * from users' },
        createdAt: new Date(base + 2000),
      }),
      entry({
        id: 'cache',
        batchId: 'bc',
        type: 'cache',
        content: { key: 'kpi.json' },
        createdAt: new Date(base + 3000),
      }),
    ]);

    expect((await store.get({ search: 'orders' })).data.map((e) => e.id)).toEqual(['req']);
    expect((await store.get({ search: 'ORDERS' })).data.map((e) => e.id)).toEqual(['req']);
    expect((await store.get({ search: 'nope' })).data).toEqual([]);
    expect((await store.get({ type: 'query', search: 'users' })).data.map((e) => e.id)).toEqual([
      'sql',
    ]);
    expect((await store.get({ type: 'request', search: 'users' })).data).toEqual([]);
  });

  it('filters by traceId, excluding other traces and null', async () => {
    const base = Date.parse('2026-01-01T00:00:00Z');
    await store.store([
      entry({ id: 'a1', batchId: 'ba1', traceId: 'trace-A', createdAt: new Date(base + 1000) }),
      entry({ id: 'a2', batchId: 'ba2', traceId: 'trace-A', createdAt: new Date(base + 2000) }),
      entry({ id: 'b1', batchId: 'bb1', traceId: 'trace-B', createdAt: new Date(base + 3000) }),
      entry({ id: 'none', batchId: 'bn', traceId: null, createdAt: new Date(base + 4000) }),
    ]);

    const page = await store.get({ traceId: 'trace-A' });
    expect(page.data.map((e) => e.id).sort()).toEqual(['a1', 'a2']);
  });

  it('windows by before/after', async () => {
    const base = Date.parse('2026-01-01T00:00:00Z');
    // ids 0..9 at base + i*1000
    await store.store(
      Array.from({ length: 10 }, (_, i) =>
        entry({ id: `e${i}`, batchId: `b${i}`, createdAt: new Date(base + i * 1000) }),
      ),
    );

    const boundary = new Date(base + 5000); // e5

    const after = await store.get({ after: boundary });
    expect(after.data.map((e) => e.id)).toEqual(['e9', 'e8', 'e7', 'e6']);
    expect(after.data.every((e) => e.createdAt.getTime() > boundary.getTime())).toBe(true);

    const before = await store.get({ before: boundary });
    expect(before.data.map((e) => e.id)).toEqual(['e4', 'e3', 'e2', 'e1', 'e0']);
    expect(before.data.every((e) => e.createdAt.getTime() < boundary.getTime())).toBe(true);
  });

  it('updates a field while keeping id immutable', async () => {
    await store.store([entry({ id: '1', durationMs: null })]);

    await store.update('1', { durationMs: 42, id: 'hacked' });

    const found = await store.find('1');
    expect(found?.id).toBe('1');
    expect(found?.durationMs).toBe(42);
    expect(await store.find('hacked')).toBeNull();
  });

  it('update is a no-op for a missing entry', async () => {
    await store.update('nope', { durationMs: 1 });
    expect(await store.find('nope')).toBeNull();
  });

  it('prunes entries older than the cutoff and decrements tag counts', async () => {
    const base = Date.parse('2026-01-01T00:00:00Z');
    await store.store([
      entry({ id: 'old1', tags: ['a'], createdAt: new Date(base) }),
      entry({ id: 'old2', tags: ['a', 'b'], createdAt: new Date(base + 1000) }),
      entry({ id: 'new1', tags: ['a'], createdAt: new Date(base + 10_000) }),
    ]);

    const cutoff = new Date(base + 5000);
    const removed = await store.prune(cutoff);

    expect(removed).toBe(2);
    expect(await store.find('old1')).toBeNull();
    expect(await store.find('old2')).toBeNull();
    expect(await store.find('new1')).not.toBeNull();

    const tagCounts = new Map((await store.tags()).map((t) => [t.tag, t.count]));
    expect(tagCounts.get('a')).toBe(1); // only new1 remains
    expect(tagCounts.get('b')).toBeUndefined(); // dropped to 0

    const page = await store.get({});
    expect(page.data.map((e) => e.id)).toEqual(['new1']);
  });

  it('prune keepLast retains the newest N of the pruned set', async () => {
    const base = Date.parse('2026-01-01T00:00:00Z');
    await store.store([
      entry({ id: 'o0', createdAt: new Date(base) }),
      entry({ id: 'o1', createdAt: new Date(base + 1000) }),
      entry({ id: 'o2', createdAt: new Date(base + 2000) }),
      entry({ id: 'o3', createdAt: new Date(base + 3000) }),
      entry({ id: 'fresh', createdAt: new Date(base + 100_000) }),
    ]);

    const cutoff = new Date(base + 50_000); // o0..o3 are old, fresh survives
    const removed = await store.prune(cutoff, 2);

    // 4 old, keep newest 2 (o3, o2), remove 2 (o1, o0).
    expect(removed).toBe(2);
    expect(await store.find('o0')).toBeNull();
    expect(await store.find('o1')).toBeNull();
    expect(await store.find('o2')).not.toBeNull();
    expect(await store.find('o3')).not.toBeNull();
    expect(await store.find('fresh')).not.toBeNull();

    const page = await store.get({});
    expect(page.data.map((e) => e.id)).toEqual(['fresh', 'o3', 'o2']);
  });

  describe('RollupStore SPI', () => {
    it('is detected as a RollupStore (both methods present)', () => {
      expect(isRollupStore(store)).toBe(true);
    });

    it('records then queries rollups (round-trip)', async () => {
      await store.recordRollups([
        { metric: 'request', bucketStart: 60_000, count: 2, sum: 30, max: 20 },
        { metric: 'query', bucketStart: 60_000, count: 1, sum: 5, max: 5 },
      ]);

      const buckets = await store.queryRollups(['request', 'query'], 0, 120_000);
      const byMetric = new Map(buckets.map((b) => [b.metric, b]));
      expect(byMetric.get('request')).toEqual({
        metric: 'request',
        bucketStart: 60_000,
        count: 2,
        sum: 30,
        max: 20,
      });
      expect(byMetric.get('query')).toEqual({
        metric: 'query',
        bucketStart: 60_000,
        count: 1,
        sum: 5,
        max: 5,
      });
    });

    it('accumulates count/sum and keeps the running max on a second record (additive contract)', async () => {
      await store.recordRollups([
        { metric: 'request', bucketStart: 60_000, count: 2, sum: 30, max: 20 },
      ]);
      // Second delta for the SAME (metric, bucket): count/sum add, max is the running max.
      await store.recordRollups([
        { metric: 'request', bucketStart: 60_000, count: 3, sum: 12, max: 8 },
      ]);

      const [bucket] = await store.queryRollups(['request'], 0, 120_000);
      expect(bucket).toEqual({
        metric: 'request',
        bucketStart: 60_000,
        count: 5, // 2 + 3
        sum: 42, // 30 + 12
        max: 20, // max(20, 8)
      });
    });

    it('raises the running max when a later delta is larger', async () => {
      await store.recordRollups([
        { metric: 'request', bucketStart: 60_000, count: 1, sum: 5, max: 5 },
      ]);
      await store.recordRollups([
        { metric: 'request', bucketStart: 60_000, count: 1, sum: 99, max: 99 },
      ]);

      const [bucket] = await store.queryRollups(['request'], 0, 120_000);
      expect(bucket?.max).toBe(99);
    });

    it('filters by metric set and bucket range; empty metrics ⇒ []', async () => {
      await store.recordRollups([
        { metric: 'request', bucketStart: 60_000, count: 1, sum: 1, max: 1 },
        { metric: 'request', bucketStart: 120_000, count: 1, sum: 1, max: 1 },
        { metric: 'request', bucketStart: 180_000, count: 1, sum: 1, max: 1 },
        { metric: 'query', bucketStart: 120_000, count: 1, sum: 1, max: 1 },
      ]);

      // Range excludes 60_000 and 180_000; metric set excludes 'query'.
      const buckets = await store.queryRollups(['request'], 100_000, 150_000);
      expect(buckets.map((b) => b.bucketStart)).toEqual([120_000]);
      expect(buckets.every((b) => b.metric === 'request')).toBe(true);

      // Both metrics in range.
      const both = await store.queryRollups(['request', 'query'], 100_000, 150_000);
      expect(new Set(both.map((b) => b.metric))).toEqual(new Set(['request', 'query']));

      // Empty metrics short-circuits.
      expect(await store.queryRollups([], 0, 1_000_000)).toEqual([]);
    });

    it('empty deltas is a no-op', async () => {
      await store.recordRollups([]);
      expect(await store.queryRollups(['request'], 0, 1_000_000)).toEqual([]);
    });

    it('clear() empties rollups too', async () => {
      await store.recordRollups([
        { metric: 'request', bucketStart: 60_000, count: 1, sum: 1, max: 1 },
      ]);
      expect(await store.queryRollups(['request'], 0, 1_000_000)).toHaveLength(1);

      await store.clear();

      expect(await store.queryRollups(['request'], 0, 1_000_000)).toEqual([]);
    });
  });
});
