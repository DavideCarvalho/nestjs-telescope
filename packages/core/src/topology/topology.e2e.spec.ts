// A control plane and tenant apps over real HTTP: entries arrive tagged with the app from the
// token, the console shows each viewer only its apps on every route, and a standalone app is
// unchanged.
import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { type Entry, EntryType } from '../entry/entry.js';
import type { ConsoleAuthorizeResult } from '../nest/console-authorize.js';
import { TelescopeController } from '../nest/telescope.controller.js';
import { TelescopeModule } from '../nest/telescope.module.js';
import type { TelescopeModuleOptions } from '../nest/telescope.options.js';
import { TelescopeService } from '../nest/telescope.service.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { hmacTenantVerifier, signTenantToken } from './tenant-auth.js';
import { ingestBatch } from './wire.js';

const SECRET = 'cp-secret';
const apps: INestApplication[] = [];

afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.close();
});

/** `x-grant` (JSON) is what `authorize` answers; absent: allowed, every app. */
const authorize = (context: ExecutionContext): ConsoleAuthorizeResult => {
  const grant = context.switchToHttp().getRequest().headers['x-grant'];
  return grant ? (JSON.parse(grant) as ConsoleAuthorizeResult) : true;
};

async function boot(options: TelescopeModuleOptions, listen = false): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [TelescopeModule.forRoot({ authorize, mutations: true, ...options })],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  apps.push(app);
  if (listen) await app.listen(0, '127.0.0.1');
  else await app.init();
  return app;
}

function urlOf(app: INestApplication): string {
  const address = app.getHttpServer().address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/telescope`;
}

async function controlPlane(storage = new InMemoryStorageProvider()) {
  const app = await boot(
    {
      topology: 'control-plane',
      verifyTenant: hmacTenantVerifier(SECRET),
      storage,
      apps: { labels: { shop: 'Shop', billing: 'Billing' } },
    },
    true,
  );
  return { app, storage, url: urlOf(app) };
}

/** A tenant app that records `count` requests for `partition`, then shuts down (flushing them). */
async function tenantSends(url: string, partition: string, marker: string): Promise<void> {
  const tenant = await boot({
    topology: 'tenant',
    tenant: { url, partition, token: signTenantToken(partition, SECRET), intervalMs: 20 },
  });
  const service = tenant.get(TelescopeService);
  await service.runInBatch('http', async () => {
    service.record({
      type: EntryType.Request,
      content: { method: 'GET', uri: `/${marker}`, statusCode: 500 },
      tags: [`app:forged-${marker}`],
      durationMs: 12,
    });
    service.record({
      type: EntryType.Exception,
      content: { class: 'Error', message: `${marker} failed` },
      familyHash: `fam-${marker}`,
    });
  });
  apps.splice(apps.indexOf(tenant), 1);
  await tenant.close();
}

async function idsOf(storage: InMemoryStorageProvider, app: string): Promise<Entry[]> {
  return (await storage.get({ tag: `app:${app}`, limit: 100 })).data;
}

describe('topology: control plane and tenants', () => {
  it('stores tenant entries tagged with the app from the token, keeping their time', async () => {
    const cp = await controlPlane();
    await tenantSends(cp.url, 'shop', 'shop-secret');
    const shop = await idsOf(cp.storage, 'shop');
    expect(shop).toHaveLength(2);
    for (const e of shop) {
      expect(e.tags).toContain('app:shop');
      expect(e.tags.some((t) => t.startsWith('app:forged'))).toBe(false);
    }
    // One batch: the two entries share the tenant's batch id and keep their own ids.
    expect(new Set(shop.map((e) => e.batchId)).size).toBe(1);
    const res = await request(cp.app.getHttpServer()).get('/telescope/api/apps').expect(200);
    expect(res.body).toEqual({
      enabled: true,
      tag: 'app',
      all: true,
      selected: null,
      apps: [{ id: 'shop', label: 'Shop' }],
    });
  });

  it('refuses a batch without a valid token and stores nothing', async () => {
    const cp = await controlPlane();
    const body = ingestBatch([]);
    await request(cp.app.getHttpServer()).post('/telescope/api/ingest').send(body).expect(401);
    await request(cp.app.getHttpServer())
      .post('/telescope/api/ingest')
      .set('authorization', `Bearer ${signTenantToken('shop', 'wrong')}`)
      .send(body)
      .expect(401);
    await request(cp.app.getHttpServer())
      .post('/telescope/api/ingest')
      .set('authorization', `Bearer ${signTenantToken('shop', SECRET)}`)
      .send({ nope: true })
      .expect(400);
    expect((await cp.storage.get({})).data).toHaveLength(0);
  });

  it('never shows app B to a viewer limited to app A, on any GET route', async () => {
    const cp = await controlPlane();
    await tenantSends(cp.url, 'shop', 'shop-visible');
    await tenantSends(cp.url, 'billing', 'billing-secret');
    const billing = await idsOf(cp.storage, 'billing');
    const billingEntry = billing[0] as Entry;
    const server = cp.app.getHttpServer();
    const grant = JSON.stringify({ allowed: true, apps: ['shop'] });
    // The marker is there for a viewer of every app, so its absence below means something.
    expect((await request(server).get('/telescope/api/entries')).text).toContain('billing-secret');

    // Every GET route of the console API, with app B's ids in its parameters.
    const proto = TelescopeController.prototype as unknown as Record<string, unknown>;
    const paths = Object.getOwnPropertyNames(proto)
      .map((name) => proto[name])
      .filter(
        (fn) =>
          typeof fn === 'function' &&
          Reflect.getMetadata(METHOD_METADATA, fn) === RequestMethod.GET,
      )
      .map((fn) => Reflect.getMetadata(PATH_METADATA, fn as object) as string)
      .map((path) =>
        path
          .replace(':traceId', billingEntry.traceId ?? 'none')
          .replace(':id', billingEntry.id)
          .replace(':ext', 'x')
          .replace(':provider', 'y')
          .replace(':driver', 'd')
          .replace(':queue', 'q'),
      );
    expect(paths.length).toBeGreaterThan(20);
    for (const path of paths) {
      for (const query of ['', '?app=billing', '?app=*', '?tag=app:billing']) {
        const url = `/telescope/api/${path}${query}`;
        const res = await request(server).get(url).set('x-grant', grant);
        expect(res.text, url).not.toContain('billing-secret');
        expect(res.text, url).not.toContain('app:billing');
        expect(res.text, url).not.toContain(billingEntry.id);
      }
    }
    // App A is visible to it.
    const own = await request(server).get('/telescope/api/entries').set('x-grant', grant);
    expect(own.text).toContain('shop-visible');
    // The picker lists only the granted app, selected.
    const picker = await request(server).get('/telescope/api/apps').set('x-grant', grant);
    expect(picker.body).toMatchObject({ enabled: true, all: false, selected: 'shop' });
    expect(picker.body.apps).toEqual([{ id: 'shop', label: 'Shop' }]);
    // Global actions are refused.
    await request(server).delete('/telescope/api/entries').set('x-grant', grant).expect(403);
    expect((await cp.storage.get({})).data.length).toBe(4);
  });

  it('lets an every-app viewer narrow with ?app=', async () => {
    const cp = await controlPlane();
    await tenantSends(cp.url, 'shop', 'shop-visible');
    await tenantSends(cp.url, 'billing', 'billing-visible');
    const server = cp.app.getHttpServer();
    const all = await request(server).get('/telescope/api/entries');
    expect(all.text).toContain('shop-visible');
    expect(all.text).toContain('billing-visible');
    const one = await request(server).get('/telescope/api/entries?app=billing');
    expect(one.text).toContain('billing-visible');
    expect(one.text).not.toContain('shop-visible');
    const picker = await request(server).get('/telescope/api/apps?app=billing');
    expect(picker.body).toMatchObject({ all: true, selected: 'billing' });
    expect(picker.body.apps.map((a: { id: string }) => a.id)).toEqual(['billing', 'shop']);
  });
});

describe('topology: standalone', () => {
  it('has no App control and no ingest route', async () => {
    const storage = new InMemoryStorageProvider();
    const app = await boot({ storage });
    const server = app.getHttpServer();
    expect((await request(server).get('/telescope/api/apps')).body).toMatchObject({
      enabled: false,
      apps: [],
    });
    await request(server)
      .post('/telescope/api/ingest')
      .set('authorization', `Bearer ${signTenantToken('shop', SECRET)}`)
      .send(ingestBatch([]))
      .expect(404);
  });

  it('fails at boot on a control plane without verifyTenant', async () => {
    await expect(
      Test.createTestingModule({
        imports: [TelescopeModule.forRoot({ topology: 'control-plane' })],
      }).compile(),
    ).rejects.toThrow(/verifyTenant/);
  });
});
