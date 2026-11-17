// The fleet wired through TelescopeModule: heartbeats from a standalone app, from tenants over
// HTTP and over a broker, the scoped `GET <path>/api/fleet`, and the probes.
import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ConsoleAuthorizeResult,
  EntryType,
  InMemoryStorageProvider,
  TelescopeFleet,
  TelescopeModule,
  type TelescopeModuleOptions,
  TelescopeService,
  checks,
  hmacTenantVerifier,
  signTenantToken,
  transports,
} from '../../src/index.js';
import { fakeRedis } from '../topology/transport-fakes.js';

const SECRET = 'fleet-secret';
const apps: INestApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.close();
});

const authorize = (context: ExecutionContext): ConsoleAuthorizeResult => {
  const grant = context.switchToHttp().getRequest().headers['x-grant'];
  return grant ? (JSON.parse(grant) as ConsoleAuthorizeResult) : true;
};

async function boot(options: TelescopeModuleOptions, listen = false): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [TelescopeModule.forRoot({ authorize, ...options })],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  apps.push(app);
  if (listen) await app.listen(0, '127.0.0.1');
  else await app.init();
  return app;
}

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out');
};

const fleetOf = async (app: INestApplication, headers: Record<string, string> = {}, query = '') =>
  (await request(app.getHttpServer()).get(`/telescope/api/fleet${query}`).set(headers).expect(200))
    .body;

describe('standalone', () => {
  it('keeps no fleet by default: unchanged', async () => {
    const app = await boot({ storage: new InMemoryStorageProvider() });
    const fleet = await fleetOf(app);
    expect(fleet).toMatchObject({ enabled: false, apps: [], self: null });
    await request(app.getHttpServer()).get('/telescope/api/probes/ready').expect(404);
  });

  it('with `fleet: true`, its own replicas beat in process and turn ready after boot', async () => {
    const app = await boot({
      storage: new InMemoryStorageProvider(),
      fleet: { app: 'shop', version: 'v7' },
    });
    await until(async () => (await fleetOf(app)).apps[0]?.instances[0]?.state === 'ready');
    const fleet = await fleetOf(app);
    expect(fleet.apps).toHaveLength(1);
    expect(fleet.apps[0]).toMatchObject({ app: 'shop', counts: { up: 1 } });
    expect(fleet.apps[0].instances[0]).toMatchObject({ version: 'v7', status: 'up' });
    expect(fleet.self).toMatchObject({ state: 'ready' });
  });
});

describe('probes', () => {
  it('readiness is 503 while a critical check is down; liveness never runs checks', async () => {
    let healthy = false;
    let runs = 0;
    const app = await boot({
      storage: new InMemoryStorageProvider(),
      health: { probes: true },
      checks: [
        checks.custom(
          'db',
          () => {
            runs += 1;
            return { status: healthy ? 'ok' : 'down', message: 'secret dsn' };
          },
          { cacheFor: 1 },
        ),
        checks.custom('stripe', () => ({ status: 'down' }), { critical: false }),
      ],
    });
    const server = app.getHttpServer();
    const live = await request(server).get('/telescope/api/probes/live').expect(200);
    expect(live.body).toEqual({ status: 'ok' });
    expect(runs).toBe(0);
    const down = await request(server).get('/telescope/api/probes/ready').expect(503);
    expect(down.body.checks).toEqual([
      { name: 'db', status: 'down' },
      { name: 'stripe', status: 'down' },
    ]);
    // Names and statuses only: no message leaks to an unauthenticated caller.
    expect(JSON.stringify(down.body)).not.toContain('secret');
    healthy = true;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const up = await request(server).get('/telescope/api/probes/ready').expect(200);
    expect(up.body.status).toBe('warn');
  });

  it('readiness answers 503 once the instance drains', async () => {
    const app = await boot({ storage: new InMemoryStorageProvider(), health: { probes: true } });
    await app.get(TelescopeFleet).beforeApplicationShutdown();
    await request(app.getHttpServer()).get('/telescope/api/probes/ready').expect(503);
  });
});

describe('control plane and tenants', () => {
  async function controlPlane(transport?: ReturnType<typeof transports.redis>) {
    const storage = new InMemoryStorageProvider();
    const app = await boot(
      {
        topology: 'control-plane',
        verifyTenant: hmacTenantVerifier(SECRET),
        storage,
        fleet: { app: 'ops' },
        ...(transport ? { transport } : {}),
      },
      true,
    );
    const address = app.getHttpServer().address() as AddressInfo;
    return { app, storage, url: `http://127.0.0.1:${address.port}/telescope` };
  }

  it("a tenant's heartbeat rides its batches; the app comes from the token", async () => {
    const cp = await controlPlane();
    const tenant = await boot({
      topology: 'tenant',
      tenant: {
        url: cp.url,
        partition: 'shop',
        token: signTenantToken('shop', SECRET),
        intervalMs: 10,
      },
      fleet: { version: 'abc' },
      checks: [checks.custom('redis', () => ({ status: 'down', message: 'OOM' }))],
    });
    await until(async () =>
      (await fleetOf(cp.app)).apps.some(
        (a: { app: string; counts: { up: number } }) => a.app === 'shop' && a.counts.up === 1,
      ),
    );
    // Recorded once the check is down: the incident lists it.
    await new Promise((resolve) => setTimeout(resolve, 5));
    tenant.get(TelescopeService).record({
      type: EntryType.Exception,
      content: { class: 'ReplyError', message: 'OOM command not allowed' },
      familyHash: 'oom',
    });
    await until(async () => (await cp.storage.get({ tag: 'app:shop' })).data.length > 0);
    const fleet = await fleetOf(cp.app);
    const shop = fleet.apps.find((a: { app: string }) => a.app === 'shop');
    expect(shop.instances[0]).toMatchObject({ version: 'abc', health: 'down' });
    expect(shop.instances[0].shipping).toMatchObject({ dropped: 0 });
    expect(shop.checks[0]).toMatchObject({ name: 'redis', status: 'down', affected: 1, of: 1 });
    expect(shop.checks[0].exceptions[0]).toMatchObject({ class: 'ReplyError', count: 1 });
    // The control plane beats in process too, as its own app.
    expect(fleet.apps.map((a: { app: string }) => a.app)).toEqual(['ops', 'shop']);

    // Shutdown: the tenant's draining heartbeat reaches the control plane.
    apps.splice(apps.indexOf(tenant), 1);
    await tenant.close();
    const after = await fleetOf(cp.app);
    expect(after.apps.find((a: { app: string }) => a.app === 'shop').counts.draining).toBe(1);
  });

  it("the App picker lists the registry's apps without the control plane's own or a tag scan", async () => {
    const cp = await controlPlane();
    const tags = vi.spyOn(cp.storage, 'tags');
    const now = new Date().toISOString();
    await cp.app.get(TelescopeFleet).heartbeat('billing', {
      v: 1,
      instanceId: 'billing-1',
      state: 'ready',
      bootedAt: now,
      sentAt: now,
    });
    await until(async () =>
      (await fleetOf(cp.app)).apps.some((a: { app: string }) => a.app === 'ops'),
    );
    const body = (await request(cp.app.getHttpServer()).get('/telescope/api/apps').expect(200))
      .body;
    // `billing` never stored an entry: it is listed because it heartbeats. `ops` is not.
    expect(body.apps.map((a: { id: string }) => a.id)).toEqual(['billing']);
    expect(tags).not.toHaveBeenCalled();
  });

  it('scopes the fleet: app-limited viewers see their apps, organization-limited ones none', async () => {
    const cp = await controlPlane();
    const fleet = cp.app.get(TelescopeFleet);
    const beat = (app: string) =>
      fleet.heartbeat(app, {
        v: 1,
        instanceId: `${app}-1`,
        host: `${app}-host`,
        pid: 1,
        version: 'v1',
        bootedAt: new Date().toISOString(),
        sentAt: new Date().toISOString(),
        state: 'ready',
        intervalMs: 15_000,
        checks: [],
        shipping: null,
      });
    await beat('shop');
    await beat('billing');
    const names = (body: { apps: { app: string }[] }) => body.apps.map((a) => a.app);
    const shopOnly = { 'x-grant': JSON.stringify({ allowed: true, apps: ['shop'] }) };
    expect(names(await fleetOf(cp.app, shopOnly))).toEqual(['shop']);
    expect(names(await fleetOf(cp.app, shopOnly, '?app=billing'))).toEqual([]);
    expect(names(await fleetOf(cp.app, {}, '?app=billing'))).toEqual(['billing']);
    const text = JSON.stringify(await fleetOf(cp.app, shopOnly));
    expect(text).not.toContain('billing');
  });

  it('a heartbeat over a broker lands in the same fleet', async () => {
    const redis = fakeRedis();
    const cp = await controlPlane(transports.redis({ client: redis.client, pollMs: 5 }));
    await boot({
      topology: 'tenant',
      tenant: {
        partition: 'billing',
        token: signTenantToken('billing', SECRET),
        transport: transports.redis({ client: redis.client }),
        intervalMs: 10,
      },
    });
    await until(async () =>
      (await fleetOf(cp.app)).apps.some((a: { app: string }) => a.app === 'billing'),
    );
  });
});
