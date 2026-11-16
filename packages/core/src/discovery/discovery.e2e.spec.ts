// Service discovery over real HTTP: a control plane, a `billing` tenant whose heartbeat carries its
// URL, and a `shop` tenant whose plain `fetch('http://billing/…')` reaches it. Plus token scoping,
// the long poll, the snapshot when the control plane is down, strict names, a standalone static
// map, and the start-time self-check.
import 'reflect-metadata';
import { mkdtempSync } from 'node:fs';
import { type IncomingHttpHeaders, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Controller, Get, type INestApplication, Module, Param, Query } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { TelescopeModule } from '../nest/telescope.module.js';
import type { TelescopeModuleOptions } from '../nest/telescope.options.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import {
  type TenantVerifier,
  hmacTenantVerifier,
  signTenantToken,
} from '../topology/tenant-auth.js';
import { DISCOVERY_SLOT, type DiscoveryContract } from './directory.js';
import { TelescopeDiscovery } from './discovery.service.js';

const SECRET = 'discovery-secret';
const apps: INestApplication[] = [];
const servers: Server[] = [];
const snapshots = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'telescope-discovery-e2e-'));

afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  // A tenant whose control plane is down keeps sending for up to 5 s on close.
}, 30_000);

/** What shop's handler fetches: `GET /call?url=…` answers the callee's body or the error's cause. */
@Controller()
class CallController {
  @Get('call')
  async call(@Query('url') url: string): Promise<{ body?: unknown; error?: string }> {
    try {
      const response = await fetch(url);
      return { body: await response.json() };
    } catch (error) {
      const cause = (error as { cause?: { name?: string; message?: string } }).cause;
      return { error: `${cause?.name}: ${cause?.message}` };
    }
  }
}

/** Billing answers who it is. */
@Controller()
class BillingController {
  @Get('invoices/:id')
  invoice(@Param('id') id: string): { app: string; id: string } {
    return { app: 'billing', id };
  }
}

async function boot(
  options: TelescopeModuleOptions,
  controllers: Array<new (...args: never[]) => unknown> = [],
): Promise<INestApplication> {
  @Module({ controllers })
  class Host {}
  const moduleRef = await Test.createTestingModule({
    imports: [TelescopeModule.forRoot({ authorize: () => true, ...options }), Host],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false, forceCloseConnections: true });
  apps.push(app);
  await app.listen(0, '127.0.0.1');
  return app;
}

function originOf(app: INestApplication | Server): string {
  const server = 'getHttpServer' in app ? app.getHttpServer() : app;
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function stop(app: INestApplication): Promise<void> {
  apps.splice(apps.indexOf(app), 1);
  await app.close();
}

async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function controlPlane(verifyTenant: TenantVerifier = hmacTenantVerifier(SECRET)) {
  const cp = await boot({
    topology: 'control-plane',
    verifyTenant,
    storage: new InMemoryStorageProvider(),
    fleet: { app: 'ops' },
  });
  return { cp, url: `${originOf(cp)}/telescope` };
}

function tenant(cpUrl: string, partition: string, extra: Partial<TelescopeModuleOptions> = {}) {
  return {
    topology: 'tenant' as const,
    tenant: { url: cpUrl, partition, token: signTenantToken(partition, SECRET), intervalMs: 20 },
    ...extra,
  };
}

/** A billing tenant whose heartbeat says where it lives. */
async function billingAt(cpUrl: string): Promise<INestApplication> {
  const port = await freePort();
  const billing = await bootOn(
    port,
    tenant(cpUrl, 'billing', { fleet: { url: `http://127.0.0.1:${port}` } }),
    [BillingController],
  );
  return billing;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  await new Promise((r) => server.close(r));
  return port;
}

async function bootOn(
  port: number,
  options: TelescopeModuleOptions,
  controllers: Array<new (...args: never[]) => unknown>,
): Promise<INestApplication> {
  @Module({ controllers })
  class Host {}
  const moduleRef = await Test.createTestingModule({
    imports: [TelescopeModule.forRoot({ authorize: () => true, ...options }), Host],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false, forceCloseConnections: true });
  apps.push(app);
  await app.listen(port, '127.0.0.1');
  return app;
}

function resolvedBy(app: INestApplication, name: string): string | undefined {
  return app.get(TelescopeDiscovery).directory?.resolve(name);
}

describe('service discovery', () => {
  it("lets shop fetch('http://billing/…') through the control plane's map, trace header included", async () => {
    const { url } = await controlPlane();
    const billing = await billingAt(url);
    const shop = await boot(
      tenant(url, 'shop', {
        discovery: { snapshotPath: join(snapshots, 'shop-1.json') },
        propagation: { targets: [originOf(billing)] },
      }),
      [CallController],
    );
    await until(() => resolvedBy(shop, 'billing'), 'shop to learn billing');

    const res = await request(shop.getHttpServer())
      .get('/call?url=http://billing/invoices/7')
      .expect(200);
    expect(res.body).toEqual({ body: { app: 'billing', id: '7' } });

    // The shared contract other libraries read.
    const contract = (globalThis as Record<symbol, unknown>)[DISCOVERY_SLOT] as DiscoveryContract;
    expect(contract.resolve('billing')).toBe(originOf(billing));
    expect(contract.appOf(originOf(billing))).toBe('billing');
  });

  it('sends the trace header to a target listed by its real origin', async () => {
    const seen: IncomingHttpHeaders[] = [];
    const sink = createServer((req, res) => {
      seen.push(req.headers);
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
    servers.push(sink);
    await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r));
    const shop = await boot(
      {
        storage: new InMemoryStorageProvider(),
        discovery: { apps: { billing: originOf(sink) } },
        propagation: { targets: [originOf(sink)] },
      },
      [CallController],
    );
    await request(shop.getHttpServer()).get('/call?url=http://billing/x').expect(200);
    expect(seen[0]?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(seen[0]?.host).toBe(originOf(sink).slice('http://'.length));
  });

  it('serves the map scoped by the token, and only on a control plane', async () => {
    const verify: TenantVerifier = ({ token }) => {
      if (token === 'all') return { tenant: 'ops' };
      if (token === 'billing-only')
        return { tenant: 'shop', capabilities: ['telescope:discovery:billing'] };
      if (token === 'ingest-only') return { tenant: 'shop', capabilities: ['telescope:ingest'] };
      if (token === 'boom') throw new Error('idp down');
      return hmacTenantVerifier(SECRET)({ token });
    };
    const { cp, url } = await controlPlane(verify);
    await billingAt(url);
    const search = await bootOn(
      await freePort(),
      tenant(url, 'search', { fleet: { url: 'https://search.internal' } }),
      [],
    );
    const server = cp.getHttpServer();
    const path = '/telescope/api/discovery';
    await until(
      () => (search.get(TelescopeDiscovery).directory?.resolve('billing') ? true : undefined),
      'both apps in the map',
    );

    const all = await request(server).get(path).set('authorization', 'Bearer all').expect(200);
    expect(Object.keys(all.body.apps)).toEqual(['billing', 'search']);
    expect(all.body.apps.search).toEqual({ url: 'https://search.internal', live: 1 });
    const one = await request(server)
      .get(path)
      .set('authorization', 'Bearer billing-only')
      .expect(200);
    expect(Object.keys(one.body.apps)).toEqual(['billing']);
    await request(server).get(path).set('authorization', 'Bearer ingest-only').expect(403);
    await request(server).get(path).set('authorization', 'Bearer nope').expect(401);
    await request(server).get(path).expect(401);
    await request(server).get(path).set('authorization', 'Bearer boom').expect(503);

    const standalone = await boot({ storage: new InMemoryStorageProvider() });
    await request(standalone.getHttpServer())
      .get(path)
      .set('authorization', 'Bearer all')
      .expect(404);
  });

  it('holds a poll until the map changes', async () => {
    const { cp, url } = await controlPlane();
    const server = cp.getHttpServer();
    const token = `Bearer ${signTenantToken('shop', SECRET)}`;
    const first = await request(server)
      .get('/telescope/api/discovery')
      .set('authorization', token)
      .expect(200);
    const startedAt = Date.now();
    const held = request(server)
      .get(`/telescope/api/discovery?since=${first.body.version}&wait=20`)
      .set('authorization', token);
    const billing = billingAt(url);
    const answered = await held;
    await billing;
    expect(answered.status).toBe(200);
    expect(Object.keys(answered.body.apps)).toEqual(['billing']);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it('keeps resolving from the snapshot while the control plane is down', async () => {
    const snapshotPath = join(snapshots, 'shop-2.json');
    const { cp, url } = await controlPlane();
    const billing = await billingAt(url);
    const shop = await boot(tenant(url, 'shop', { discovery: { snapshotPath } }), [CallController]);
    await until(() => resolvedBy(shop, 'billing'), 'shop to learn billing');
    await stop(shop);
    await stop(cp);

    // A fresh shop process, the control plane unreachable: the snapshot answers.
    const again = await boot(tenant(url, 'shop', { discovery: { snapshotPath } }), [
      CallController,
    ]);
    expect(resolvedBy(again, 'billing')).toBe(originOf(billing));
    const res = await request(again.getHttpServer())
      .get('/call?url=http://billing/invoices/1')
      .expect(200);
    expect(res.body).toEqual({ body: { app: 'billing', id: '1' } });
    // Another app sharing the path never reads shop's snapshot.
    const other = await boot(tenant(url, 'search', { discovery: { snapshotPath } }), []);
    expect(resolvedBy(other, 'billing')).toBeUndefined();
    // Each tenant keeps trying the down control plane for up to 5 s on close: close them together.
    await Promise.all([stop(again), stop(other), stop(billing)]);
  }, 20_000);

  it('fails an unknown name with strict, and resolves a standalone static map', async () => {
    const sink = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end('{"static":true}');
    });
    servers.push(sink);
    await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r));
    const app = await boot(
      {
        storage: new InMemoryStorageProvider(),
        discovery: { apps: { billing: originOf(sink) }, strict: true, passthrough: ['minio'] },
      },
      [CallController],
    );
    const server = app.getHttpServer();
    const ok = await request(server).get('/call?url=http://billing/x').expect(200);
    expect(ok.body).toEqual({ body: { static: true } });
    const unknown = await request(server).get('/call?url=http://billng/x').expect(200);
    expect(unknown.body.error).toBe(
      'DiscoveryError: telescope: app billng is not registered: no app named "billng" in discovery.apps or on the control plane. Add it to discovery.apps, or to discovery.passthrough if "billng" is a host, not an app (discovery.strict is on).',
    );
  });

  it('resolves names in node:http with `nodeHttp`, and only then', async () => {
    const sink = createServer((req, res) => res.end(req.url));
    servers.push(sink);
    await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r));
    const http = await import('node:http');
    const get = (url: string) =>
      new Promise<string>((resolve, reject) => {
        http
          .get(url, (res) => {
            let body = '';
            res.on('data', (chunk) => {
              body += chunk;
            });
            res.on('end', () => resolve(body));
          })
          .on('error', reject);
      });
    const app = await boot({
      storage: new InMemoryStorageProvider(),
      discovery: { apps: { billing: `${originOf(sink)}/base` }, nodeHttp: true, strict: true },
    });
    expect(await get('http://billing/invoices?x=1')).toBe('/base/invoices?x=1');
    await expect(get('http://billng/x')).rejects.toThrow(/app billng is not registered/);
    await stop(app);
    // Uninstalled with the app: `http.get` is Node's own again.
    expect(http.get.name).not.toBe('discoveryRequest');
  });

  it('leaves a standalone app that configures nothing untouched', async () => {
    const before = (globalThis as Record<symbol, unknown>)[DISCOVERY_SLOT];
    const app = await boot({ storage: new InMemoryStorageProvider() });
    expect(app.get(TelescopeDiscovery).directory).toBeNull();
    expect((globalThis as Record<symbol, unknown>)[DISCOVERY_SLOT]).toBe(before);
  });

  it('fails the start when fetch no longer goes through the rewrite', async () => {
    const slot = globalThis as Record<symbol, unknown>;
    const keys = [Symbol.for('undici.globalDispatcher.2'), Symbol.for('undici.globalDispatcher.1')];
    const app = await boot({
      storage: new InMemoryStorageProvider(),
      discovery: { apps: { billing: 'http://127.0.0.1:1' } },
    });
    const discovery = app.get(TelescopeDiscovery);
    await expect(discovery.onApplicationBootstrap()).resolves.toBeUndefined();
    const saved = keys.map((key) => slot[key]);
    // Something replaced the dispatcher with one that cannot be composed onto.
    const swapped = {
      dispatch(
        _opts: unknown,
        handler: { onError?: (e: Error) => void; onResponseError?: (c: unknown, e: Error) => void },
      ) {
        const error = new Error('swapped');
        if (handler.onResponseError) handler.onResponseError(null, error);
        else handler.onError?.(error);
        return true;
      },
    };
    for (const key of keys) if (slot[key] !== undefined) slot[key] = swapped;
    try {
      await expect(discovery.onApplicationBootstrap()).rejects.toThrow(/does not go through/);
    } finally {
      keys.forEach((key, i) => {
        slot[key] = saved[i];
      });
    }
  });
});
