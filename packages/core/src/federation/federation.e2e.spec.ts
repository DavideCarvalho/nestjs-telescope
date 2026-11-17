// A federated console over HTTP: two apps keep their own telescope stores (one SQLite file, one
// in memory), and a central console reads them in place next to its own store, where a shipped
// app's entries also land. App scoping, `authorize` grants, merged paging and the actions that
// need the app's own process.
import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type Entry, EntryType } from '../entry/entry.js';
import type { ConsoleAuthorizeResult } from '../nest/console-authorize.js';
import { TelescopeModule } from '../nest/telescope.module.js';
import type { TelescopeModuleOptions } from '../nest/telescope.options.js';
import { TelescopeService } from '../nest/telescope.service.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { SqliteStorageProvider } from '../storage/sqlite-storage-provider.js';
import { hmacTenantVerifier } from '../topology/tenant-auth.js';

const apps: INestApplication[] = [];
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'telescope-federation-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.close();
});

/** `x-grant` (JSON) is what `authorize` answers; absent: allowed, every app. */
const authorize = (context: ExecutionContext): ConsoleAuthorizeResult => {
  const grant = context.switchToHttp().getRequest().headers['x-grant'];
  return grant ? (JSON.parse(grant) as ConsoleAuthorizeResult) : true;
};

async function boot(options: TelescopeModuleOptions): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [TelescopeModule.forRoot({ authorize, mutations: true, ...options })],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  apps.push(app);
  await app.init();
  return app;
}

/** An app with its own telescope store records `count` requests, then shuts down (flushing). */
async function appRecords(storage: InMemoryStorageProvider | SqliteStorageProvider, name: string) {
  const app = await boot({ storage });
  const service = app.get(TelescopeService);
  for (let i = 0; i < 3; i += 1) {
    await service.runInBatch('http', async () => {
      service.record({
        type: EntryType.Request,
        content: { method: 'GET', uri: `/${name}/${i}`, statusCode: 200 },
        durationMs: 5 + i,
      });
    });
    // Distinct times across apps, so the merged order is checkable.
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
  await service.flush();
}

function shipped(app: string, at: number): Entry {
  return {
    id: `shipped-${app}-${at}`,
    batchId: `batch-${app}-${at}`,
    type: EntryType.Request,
    familyHash: null,
    content: { method: 'GET', uri: `/${app}`, statusCode: 200 },
    tags: [`app:${app}`],
    createdAt: new Date(at),
    durationMs: 1,
    sequence: 0,
    origin: 'http',
    instanceId: app,
    traceId: null,
    spanId: null,
  } as Entry;
}

async function setup() {
  const path = join(dir, `billing-${Date.now()}-${Math.random()}.sqlite`);
  // billing: its own SQLite file (the app's database); orders: its own in-memory store.
  const billingStore = new SqliteStorageProvider({ path });
  const ordersStore = new InMemoryStorageProvider();
  await appRecords(billingStore, 'billing');
  await appRecords(ordersStore, 'orders');

  // The central console: a control plane (shop ships to it) that also reads billing and orders.
  const home = new InMemoryStorageProvider();
  const now = Date.now();
  await home.store([shipped('shop', now - 60_000), shipped('shop', now - 30_000)]);
  const central = await boot({
    topology: 'control-plane',
    verifyTenant: hmacTenantVerifier('secret'),
    storage: home,
    apps: { labels: { shop: 'Shop' } },
    federation: {
      apps: {
        // A factory: the central opens the app's database itself (read grants are enough).
        billing: { storage: () => new SqliteStorageProvider({ path }), label: 'Billing' },
        orders: { storage: ordersStore },
      },
    },
  });
  return { server: central.getHttpServer(), home, ordersStore, billingStore };
}

async function pages(server: unknown, query: string, headers: Record<string, string> = {}) {
  const uris: string[] = [];
  let after: string | null = null;
  for (let i = 0; i < 30; i += 1) {
    const url: string = `/telescope/api/entries?first=2${query}${after ? `&after=${encodeURIComponent(after)}` : ''}`;
    const res = await request(server as never)
      .get(url)
      .set(headers)
      .expect(200);
    uris.push(...res.body.data.map((e: { content: { uri: string } }) => e.content.uri));
    after = res.body.meta.nextCursor;
    if (after === null) return uris;
  }
  throw new Error('paging did not end');
}

describe('federation: a central console reading apps’ own stores', () => {
  it('lists federated apps in the App picker, with their labels', async () => {
    const { server } = await setup();
    const res = await request(server).get('/telescope/api/apps').expect(200);
    expect(res.body).toMatchObject({
      enabled: true,
      all: true,
      selected: null,
      federation: { selected: false },
    });
    expect(res.body.apps).toEqual([
      { id: 'billing', label: 'Billing', federated: true },
      { id: 'orders', label: 'orders', federated: true },
      { id: 'shop', label: 'Shop' },
    ]);
    const one = await request(server).get('/telescope/api/apps?app=billing').expect(200);
    expect(one.body).toMatchObject({ selected: 'billing', federation: { selected: true } });
  });

  it('answers each read from the selected app’s store', async () => {
    const { server } = await setup();
    const billing = await pages(server, '&app=billing');
    expect(billing.sort()).toEqual(['/billing/0', '/billing/1', '/billing/2']);
    const shop = await pages(server, '&app=shop');
    expect(shop).toEqual(['/shop', '/shop']);
    const pulse = await request(server).get('/telescope/api/pulse?app=orders').expect(200);
    expect(pulse.body.counts.request).toBe(3);
  });

  it('merges every store for All apps, paging newest first without repeats', async () => {
    const { server } = await setup();
    const uris = await pages(server, '');
    expect(uris).toHaveLength(8);
    expect(uris.filter((u) => u.startsWith('/billing'))).toEqual([
      '/billing/2',
      '/billing/1',
      '/billing/0',
    ]);
    expect(uris.filter((u) => u.startsWith('/orders'))).toEqual([
      '/orders/2',
      '/orders/1',
      '/orders/0',
    ]);
    // The apps recorded after the shop's (older) shipped entries: those come last.
    expect(uris.slice(-2)).toEqual(['/shop', '/shop']);
    const pulse = await request(server).get('/telescope/api/pulse').expect(200);
    expect(pulse.body.counts.request).toBe(8);
  });

  it('holds a viewer to the apps `authorize` grants, federated or shipped', async () => {
    const { server } = await setup();
    const grant = { 'x-grant': JSON.stringify({ allowed: true, apps: ['billing', 'shop'] }) };
    const uris = await pages(server, '', grant);
    expect(uris.filter((u) => u.startsWith('/orders'))).toEqual([]);
    expect(uris).toHaveLength(5);
    // An app outside the grant answers empty, never another app's entries.
    expect(await pages(server, '&app=orders', grant)).toEqual([]);
    const picker = await request(server).get('/telescope/api/apps').set(grant).expect(200);
    expect(picker.body.apps.map((a: { id: string }) => a.id)).toEqual(['billing', 'shop']);
  });

  it('opens a federated entry, but replays it only in its own app', async () => {
    const { server, ordersStore } = await setup();
    const [first] = (await ordersStore.get({ limit: 1 })).data;
    const id = (first as Entry).id;
    const shown = await request(server).get(`/telescope/api/entries/${id}?app=orders`).expect(200);
    expect(shown.body.id).toBe(id);
    expect(shown.body.batch.length).toBeGreaterThan(0);
    // Hidden from another app's view.
    const other = await request(server).get(`/telescope/api/entries/${id}?app=billing`);
    expect(other.body).toEqual({});
    const replay = await request(server).get(`/telescope/api/entries/${id}/replay`).expect(409);
    expect(replay.body.message).toContain('orders');
  });

  it('reads a trace across the stores the viewer’s apps reach, hiding the rest', async () => {
    const { server, home, ordersStore, billingStore } = await setup();
    const at = Date.now() - 10_000;
    const span = (app: string, offset: number): Entry => ({
      ...shipped(app, at + offset),
      id: `span-${app}`,
      traceId: 'trace-1',
      tags: [],
    });
    await ordersStore.store([span('orders', 0)]);
    await billingStore.store([span('billing', 5)]);
    await home.store([{ ...span('shop', 10), tags: ['app:shop'] }]);

    // An every-app viewer sees the whole trace, whatever app is picked.
    const all = await request(server)
      .get('/telescope/api/traces/trace-1/waterfall?app=orders')
      .expect(200);
    expect(all.body.spans).toHaveLength(3);
    expect(all.body.hiddenSpans).toBeUndefined();

    // A viewer of orders and shop: their spans, and the billing one counted, never shown.
    const grant = { 'x-grant': JSON.stringify({ allowed: true, apps: ['orders', 'shop'] }) };
    const limited = await request(server)
      .get('/telescope/api/traces/trace-1/waterfall')
      .set(grant)
      .expect(200);
    expect(limited.body.spans).toHaveLength(2);
    expect(limited.body.hiddenSpans).toBe(1);

    // A viewer of billing alone still opens it: billing's span comes from its own store.
    const billingOnly = { 'x-grant': JSON.stringify({ allowed: true, apps: ['billing'] }) };
    const one = await request(server)
      .get('/telescope/api/traces/trace-1/waterfall?app=billing')
      .set(billingOnly)
      .expect(200);
    expect(one.body.spans).toHaveLength(1);
    expect(one.body.hiddenSpans).toBe(2);
  });

  it('keeps writes on its own store: clear never touches an app’s store', async () => {
    const { server, home, ordersStore } = await setup();
    await request(server).delete('/telescope/api/entries?app=orders').expect(403);
    await request(server).delete('/telescope/api/entries').expect(200);
    expect((await home.get({})).data).toEqual([]);
    expect((await ordersStore.get({})).data).toHaveLength(3);
  });

  it('shows no live queues of this process for a federated app', async () => {
    const { server } = await setup();
    const res = await request(server).get('/telescope/api/queues/live?app=orders').expect(200);
    expect(res.body.queues).toEqual([]);
  });
});
