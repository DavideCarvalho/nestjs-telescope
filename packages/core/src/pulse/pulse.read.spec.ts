// packages/core/src/pulse/pulse.read.spec.ts
//
// One Pulse read for a page: only the asked cards, the throughput from the counts' read, and a
// console view of one app answered by the store's aggregations instead of a capped scan.
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { bucketTimeseries } from '../metrics/timeseries.js';
import { TimeseriesService } from '../metrics/timeseries.service.js';
import { appViewOf } from '../nest/console-app-scope.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { SqliteStorageProvider } from '../storage/sqlite-storage-provider.js';
import type { EntryAggregation, StorageProvider } from '../storage/storage-provider.js';
import {
  ScopedAggregateUnsupported,
  asTenantScopedStorage,
  tenantViewOf,
  withTenantView,
} from '../storage/tenant-scoped-storage.js';
import { PulseService } from './pulse.service.js';

let seq = 0;
function entry(type: string, at: number, extra: Partial<Entry> = {}): Entry {
  seq += 1;
  return {
    id: `e-${String(seq).padStart(6, '0')}`,
    batchId: `b-${seq % 3}`,
    type,
    familyHash: type === 'exception' ? 'Error:boom' : type === 'request' ? 'GET /a' : null,
    content: type === 'request' ? { method: 'GET', uri: '/a' } : { class: 'Error', message: 'x' },
    tags: [],
    sequence: 0,
    durationMs: type === 'exception' ? null : 10 + (seq % 50),
    origin: 'http',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt: new Date(at),
    ...extra,
  };
}

function seed(now: number): Entry[] {
  const rows: Entry[] = [];
  for (let i = 0; i < 40; i++) {
    const app = i % 2 === 0 ? 'shop' : 'billing';
    rows.push(entry('request', now - i * 60_000, { tags: [`app:${app}`, `user:u${i % 4}`] }));
    rows.push(entry('query', now - i * 60_000 + 5, { tags: [`app:${app}`] }));
    if (i % 5 === 0) rows.push(entry('exception', now - i * 60_000 + 7, { tags: [`app:${app}`] }));
  }
  return rows;
}

const ASKED = ['slowest', 'nPlusOne'];

// A fixed clock: two reads a few ms apart must cut the window into the same buckets.
const NOW = Date.parse('2026-11-17T12:00:00.000Z');
beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('PulseService read options', () => {
  it('reads only what the asked cards need, and empties the others', async () => {
    const store = new SqliteStorageProvider({ path: ':memory:' });
    await store.store(seed(NOW - 1_234));
    const aggregate = vi.spyOn(store, 'aggregate');
    const full = await new PulseService(store).getHealth(3_600_000);
    const kinds = (calls: typeof aggregate.mock.calls) =>
      calls.map(([request]) => (request as EntryAggregation).kind).sort();
    expect(kinds(aggregate.mock.calls)).toEqual([
      'batchFamilies',
      'count',
      'families',
      'slowest',
      'tagSets',
    ]);
    aggregate.mockClear();

    const some = await new PulseService(store).getHealth(3_600_000, { cards: ASKED });
    expect(kinds(aggregate.mock.calls)).toEqual(['batchFamilies', 'count', 'slowest']);
    expect(some.counts).toEqual(full.counts);
    expect(some.slowest).toEqual(full.slowest);
    expect(some.topExceptions).toEqual([]);
    expect(some.slowRoutes).toEqual([]);
    expect(some.loadByUser).toEqual([]);
    expect(full.topExceptions.length).toBeGreaterThan(0);
    expect(full.loadByUser.length).toBeGreaterThan(0);
    await store.close?.();
  });

  it('family types follow the cards: no outgoing calls read for the Overview', async () => {
    const store = new SqliteStorageProvider({ path: ':memory:' });
    await store.store(seed(NOW - 1_234));
    const aggregate = vi.spyOn(store, 'aggregate');
    await new PulseService(store).getHealth(3_600_000, {
      cards: ['slowRoutes', 'slowJobs', 'exceptions'],
    });
    const families = aggregate.mock.calls
      .map(([request]) => request as EntryAggregation)
      .find((request) => request.kind === 'families');
    expect(families?.window.types).toEqual(['request', 'job', 'exception']);
    await store.close?.();
  });

  it('ignores unknown cards, and computes them all when none is known', async () => {
    const store = new InMemoryStorageProvider();
    await store.store(seed(NOW - 1_234));
    const report = await new PulseService(store).getHealth(3_600_000, { cards: ['nope'] });
    expect(report.topExceptions.length).toBeGreaterThan(0);
  });

  it('the scan path empties the cards not asked for too', async () => {
    const store = new InMemoryStorageProvider();
    await store.store(seed(NOW - 1_234));
    const report = await new PulseService(store).getHealth(3_600_000, { cards: ASKED });
    expect(report.slowest.length).toBeGreaterThan(0);
    expect(report.topExceptions).toEqual([]);
    expect(report.loadByUser).toEqual([]);
  });

  it.each([
    ['the store aggregates (sqlite)', () => new SqliteStorageProvider({ path: ':memory:' })],
    ['the window is scanned (memory)', () => new InMemoryStorageProvider()],
  ])('with buckets, the throughput comes from the same read as the counts: %s', async (_, make) => {
    const store: StorageProvider = make();
    await store.store(seed(NOW - 1_234));
    const report = await new PulseService(store).getHealth(3_600_000, { buckets: 12 });
    const series = report.timeseries;
    expect(series?.buckets).toHaveLength(12);
    const total = series?.buckets.reduce((sum, bucket) => sum + bucket.total, 0);
    expect(total).toBe(Object.values(report.counts).reduce((sum, count) => sum + count, 0));
    // The same buckets as GET timeseries draws from the window's entries.
    const entries = seed(NOW - 1_234).filter((row) => row.createdAt.getTime() > NOW - 3_600_000);
    const alone = bucketTimeseries(entries, new Date(NOW - 3_600_000), new Date(NOW), 12);
    expect(series?.buckets).toEqual(alone.buckets);
    expect(series?.bucketMs).toBe(alone.bucketMs);
    await store.close?.();
  });

  it('without buckets, no timeseries', async () => {
    const store = new InMemoryStorageProvider();
    const report = await new PulseService(store).getHealth(3_600_000);
    expect(report).not.toHaveProperty('timeseries');
  });
});

describe('a console view of one app', () => {
  it("is aggregated by the store for that app's tag: complete, not a capped scan", async () => {
    const raw = new SqliteStorageProvider({ path: ':memory:' });
    await raw.store(seed(NOW - 1_234));
    const store = asTenantScopedStorage(raw);
    const aggregate = vi.spyOn(raw, 'aggregate');
    const get = vi.spyOn(raw, 'get');
    // A scan capped at 10 entries would be truncated: the aggregation is not.
    const pulse = new PulseService(store, { scanCap: 10, pageSize: 5 });
    const scoped = await withTenantView(appViewOf({ kind: 'apps', ids: ['shop'] }), () =>
      pulse.getHealth(3_600_000, { buckets: 6 }),
    );
    expect(scoped.truncated).toBe(false);
    expect(aggregate.mock.calls.every(([request]) => request.window.tag === 'app:shop')).toBe(true);
    // Only the hydration of displayed rows reads entries.
    expect(get.mock.calls.every(([query]) => query.limit !== 5)).toBe(true);
    // The same numbers as the unscoped store over shop's entries only.
    const shopOnly = new SqliteStorageProvider({ path: ':memory:' });
    await shopOnly.store(
      (await raw.get({ tag: 'app:shop', limit: 1000 })).data.map((row) => ({ ...row })),
    );
    const expected = await new PulseService(shopOnly).getHealth(3_600_000, { buckets: 6 });
    expect(scoped.counts).toEqual(expected.counts);
    expect(scoped.slowest.map((row) => row.id)).toEqual(expected.slowest.map((row) => row.id));
    expect(scoped.timeseries?.buckets.map((bucket) => bucket.total)).toEqual(
      expected.timeseries?.buckets.map((bucket) => bucket.total),
    );
    await raw.close?.();
    await shopOnly.close?.();
  });

  it('is not aggregated when the view is not exactly one tag (it scans)', async () => {
    const raw = new SqliteStorageProvider({ path: ':memory:' });
    const store = asTenantScopedStorage(raw);
    const several = appViewOf({ kind: 'apps', ids: ['shop', 'billing'] });
    const shared = tenantViewOf({ kind: 'tenant', id: 'acme' }, 'org', 'shared');
    for (const view of [several, shared]) {
      expect(await withTenantView(view, async () => store.aggregate)).toBeUndefined();
    }
    const exact = tenantViewOf({ kind: 'tenant', id: 'acme' }, 'org', 'tenantless');
    expect(typeof (await withTenantView(exact, async () => store.aggregate))).toBe('function');
    // Rollups stay hidden in any view (they carry no tags).
    expect(
      await withTenantView(exact, async () => (store as { queryRollups?: unknown }).queryRollups),
    ).toBeUndefined();
    await raw.close?.();
  });

  it('refuses a request already filtered by another tag, and the timeseries scans instead', async () => {
    const raw = new SqliteStorageProvider({ path: ':memory:' });
    await raw.store(seed(NOW - 1_234));
    const store = asTenantScopedStorage(raw);
    const view = appViewOf({ kind: 'apps', ids: ['shop'] });
    await withTenantView(view, async () => {
      await expect(
        store.aggregate?.({ kind: 'count', window: { after: new Date(0), tag: 'user:u0' } }),
      ).rejects.toBeInstanceOf(ScopedAggregateUnsupported);
      const series = await new TimeseriesService(store).getTimeseries({
        windowMs: 3_600_000,
        buckets: 4,
        tag: 'user:u0',
      });
      // Scanned: shop's requests of u0 (i in 0, 4, 8, … with i even → every 4th).
      expect(series.scanned).toBe(10);
    });
    await raw.close?.();
  });
});
