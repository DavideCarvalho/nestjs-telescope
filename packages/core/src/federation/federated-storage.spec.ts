// packages/core/src/federation/federated-storage.spec.ts
import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { appViewOf } from '../nest/console-app-scope.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import type { EntryAggregation, StorageProvider } from '../storage/storage-provider.js';
import { asTenantScopedStorage, withTenantView } from '../storage/tenant-scoped-storage.js';
import {
  FederatedStorage,
  decodeMergedCursor,
  mergeAggregates,
  mergeRollups,
} from './federated-storage.js';
import { type FederationScope, federationScopeOf, withFederationScope } from './scope.js';

let seq = 0;
function entry(at: number, tags: string[] = [], extra: Partial<Entry> = {}): Entry {
  seq += 1;
  return {
    id: `e${String(seq).padStart(4, '0')}`,
    batchId: `b${seq}`,
    type: 'request',
    familyHash: null,
    content: { at },
    tags,
    createdAt: new Date(at),
    durationMs: 10,
    ...extra,
  } as Entry;
}

async function stores() {
  const home = new InMemoryStorageProvider();
  const billing = new InMemoryStorageProvider();
  const orders = new InMemoryStorageProvider();
  // Interleaved times, with some exact ties across stores.
  await home.store([entry(1000, ['app:shop']), entry(4000), entry(7000, ['app:shop'])]);
  await billing.store([entry(2000), entry(4000), entry(5000), entry(8000)]);
  await orders.store([entry(3000), entry(4000), entry(6000), entry(9000)]);
  const federated = new FederatedStorage(
    asTenantScopedStorage(home),
    [
      { name: 'billing', storage: billing },
      { name: 'orders', storage: () => orders },
    ],
    asTenantScopedStorage,
  );
  await federated.init();
  return { home, billing, orders, federated };
}

const ALL: FederationScope = federationScopeOf({ kind: 'all' }, null, null, ['billing', 'orders']);

async function readAll(storage: StorageProvider, limit: number): Promise<Entry[]> {
  const seen: Entry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const result = await storage.get({ limit, ...(cursor ? { cursor } : {}) });
    seen.push(...result.data);
    if (result.nextCursor === null) return seen;
    cursor = result.nextCursor;
  }
  throw new Error('did not end');
}

describe('FederatedStorage', () => {
  it('outside a console call reads and writes only this app’s store', async () => {
    const { federated, billing } = await stores();
    expect((await federated.get({})).data).toHaveLength(3);
    await federated.store([entry(10_000)]);
    expect((await federated.get({})).data).toHaveLength(4);
    expect((await billing.get({})).data).toHaveLength(4);
    await federated.clear();
    expect((await billing.get({})).data).toHaveLength(4);
  });

  it.each([1, 2, 3, 5, 50])(
    'merges every store newest first, page size %i, without repeats or gaps',
    async (limit) => {
      const { federated } = await stores();
      const seen = await withFederationScope(ALL, () => readAll(federated, limit));
      expect(seen).toHaveLength(11);
      expect(new Set(seen.map((e) => e.id)).size).toBe(11);
      const times = seen.map((e) => e.createdAt.getTime());
      expect(times).toEqual([...times].sort((a, b) => b - a));
    },
  );

  it('keeps a merged cursor that names each store’s position', async () => {
    const { federated } = await stores();
    const page = await withFederationScope(ALL, () => federated.get({ limit: 2 }));
    expect(page.data.map((e) => e.createdAt.getTime())).toEqual([9000, 8000]);
    const positions = decodeMergedCursor(page.nextCursor as string);
    expect(Object.keys(positions ?? {}).sort()).toEqual(['billing', 'orders']);
  });

  it('reads one app’s store alone, and narrows this app’s store by the app tag', async () => {
    const { federated } = await stores();
    const billingOnly = federationScopeOf({ kind: 'apps', ids: ['billing'] }, null, null, [
      'billing',
      'orders',
    ]);
    const billing = await withFederationScope(billingOnly, () => federated.get({}));
    expect(billing.data).toHaveLength(4);

    const view = appViewOf({ kind: 'apps', ids: ['shop', 'orders'] });
    const mixed = federationScopeOf({ kind: 'apps', ids: ['shop', 'orders'] }, null, view, [
      'billing',
      'orders',
    ]);
    const seen = await withFederationScope(mixed, () =>
      withTenantView(view, () => readAll(federated, 2)),
    );
    // shop's two shipped entries in this app's store, and every entry of orders' own store.
    expect(seen.map((e) => e.createdAt.getTime())).toEqual([9000, 7000, 6000, 4000, 3000, 1000]);
  });

  it('answers nothing for a selection outside the grant', async () => {
    const { federated } = await stores();
    const none = federationScopeOf({ kind: 'none' }, null, null, ['billing']);
    expect((await withFederationScope(none, () => federated.get({}))).data).toEqual([]);
    expect(await withFederationScope(none, () => federated.find('e0001'))).toBeNull();
  });

  it('finds an entry in whichever store holds it, and says which federated app', async () => {
    const { federated, orders } = await stores();
    const [first] = (await orders.get({ limit: 1 })).data;
    const id = (first as Entry).id;
    expect(await federated.find(id)).toBeNull();
    const found = await withFederationScope(ALL, () => federated.find(id));
    expect(found?.id).toBe(id);
    expect(await withFederationScope(ALL, () => federated.federatedAppOf(id))).toBe('orders');
  });

  it('leaves a failing federated store out and marks the page partial', async () => {
    const home = new InMemoryStorageProvider();
    await home.store([entry(1000), entry(2000)]);
    const broken = new InMemoryStorageProvider();
    broken.get = async () => {
      throw new Error('connection refused');
    };
    const federated = new FederatedStorage(home, [{ name: 'down', storage: broken }]);
    const scope = federationScopeOf({ kind: 'all' }, null, null, ['down']);
    const page = await withFederationScope(scope, () => federated.get({}));
    expect(page.data).toHaveLength(2);
    expect(page.partial).toBe(true);
    expect(page.nextCursor).toBeNull();
  });

  it('sums tags across stores', async () => {
    const { federated } = await stores();
    const tags = await withFederationScope(ALL, () => federated.tags('app:'));
    expect(tags).toEqual([{ tag: 'app:shop', count: 2 }]);
  });

  it('offers aggregate only when every store of the call does, and merges it', async () => {
    const { federated } = await stores();
    // The in-memory store has no aggregate: the metrics scan instead.
    expect(await withFederationScope(ALL, async () => typeof federated.aggregate)).toBe(
      'undefined',
    );
    expect(await withFederationScope(ALL, async () => typeof federated.queryRollups)).toBe(
      'function',
    );
  });
});

describe('merging aggregations', () => {
  const window = { after: new Date(0) };
  it('sums counts per type and bucket', () => {
    const request: EntryAggregation = { kind: 'count', window };
    const merged = mergeAggregates(request, [
      { kind: 'count', rows: [{ type: 'request', bucket: 1, count: 2 }] },
      {
        kind: 'count',
        rows: [
          { type: 'request', bucket: 1, count: 3 },
          { type: 'query', bucket: null, count: 1 },
        ],
      },
    ]);
    expect(merged).toEqual({
      kind: 'count',
      rows: [
        { type: 'request', bucket: 1, count: 5 },
        { type: 'query', bucket: null, count: 1 },
      ],
    });
  });

  it('keeps the slowest overall', () => {
    const merged = mergeAggregates({ kind: 'slowest', window, limit: 2 }, [
      { kind: 'slowest', rows: [{ id: 'a', type: 'request', durationMs: 5, batchId: 'x' }] },
      {
        kind: 'slowest',
        rows: [
          { id: 'b', type: 'request', durationMs: 9, batchId: 'y' },
          { id: 'c', type: 'request', durationMs: 1, batchId: 'z' },
        ],
      },
    ]);
    expect(merged.rows.map((row) => (row as { id: string }).id)).toEqual(['b', 'a']);
  });

  it('adds families up, weighting quantiles by their durations', () => {
    const merged = mergeAggregates({ kind: 'families', window, quantiles: [0.5] }, [
      {
        kind: 'families',
        rows: [
          {
            type: 'request',
            familyHash: 'f',
            count: 1,
            durationCount: 1,
            durationSum: 10,
            quantiles: [10],
          },
        ],
      },
      {
        kind: 'families',
        rows: [
          {
            type: 'request',
            familyHash: 'f',
            count: 3,
            durationCount: 3,
            durationSum: 60,
            quantiles: [20],
          },
        ],
      },
    ]);
    expect(merged.rows).toEqual([
      {
        type: 'request',
        familyHash: 'f',
        count: 4,
        durationCount: 4,
        durationSum: 70,
        quantiles: [17.5],
      },
    ]);
  });

  it('sums rollups of the same minute', () => {
    const bucket = { metric: 'request', bucketStart: 0, count: 1, sum: 5, max: 5 };
    const histogram = new Array(14).fill(0);
    const merged = mergeRollups([
      { ...bucket, histogram: [...histogram] },
      { ...bucket, count: 2, sum: 10, max: 8, histogram: [...histogram] },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ count: 3, sum: 15, max: 8 });
  });
});
