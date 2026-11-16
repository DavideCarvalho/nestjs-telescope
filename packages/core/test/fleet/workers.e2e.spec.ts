// Workers in the fleet: a Nest application context (no HTTP server) reports with a role, a
// short-lived one never becomes an instance, and the control plane takes heartbeats with and
// without a role.
import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InMemoryStorageProvider,
  TelescopeFleet,
  TelescopeModule,
  type TelescopeModuleOptions,
  checks,
  createIngestHandler,
  hmacTenantVerifier,
  ingestBatch,
  markFleetWorker,
  signTenantToken,
} from '../../src/index.js';

const SECRET = 'workers-secret';
const opened: INestApplicationContext[] = [];
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const app of opened.splice(0).reverse()) await app.close();
});

/** A standalone application context, like `NestFactory.createApplicationContext`. */
async function context(options: TelescopeModuleOptions): Promise<INestApplicationContext> {
  const moduleRef = await Test.createTestingModule({
    imports: [TelescopeModule.forRoot(options)],
  }).compile();
  opened.push(moduleRef);
  await moduleRef.init();
  return moduleRef;
}

async function web(options: TelescopeModuleOptions, listen = false): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [TelescopeModule.forRoot(options)],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  opened.push(app);
  if (listen) await app.listen(0, '127.0.0.1');
  else await app.init();
  return app;
}

const until = async (check: () => Promise<boolean> | boolean) => {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out');
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('workers in a standalone app', () => {
  it('an HTTP server reports as web, from boot', async () => {
    const app = await web({ storage: new InMemoryStorageProvider(), fleet: { app: 'shop' } });
    const fleet = app.get(TelescopeFleet);
    await until(async () => (await fleet.registry?.view())?.[0]?.instances[0]?.state === 'ready');
    const [shop] = (await fleet.registry?.view()) ?? [];
    expect(shop?.instances[0]?.role).toBe('web');
    expect(shop?.roles).toEqual([
      { role: 'web', counts: { up: 1, starting: 0, draining: 0, gone: 0 } },
    ]);
  });

  it('an application context reports as a worker named by its marks, once it has run workerAfter', async () => {
    releases.push(markFleetWorker('bullmq'), markFleetWorker('durable'));
    const app = await context({
      storage: new InMemoryStorageProvider(),
      fleet: { app: 'shop', workerAfter: 60 },
      checks: [checks.custom('redis', () => ({ status: 'ok' }))],
    });
    const fleet = app.get(TelescopeFleet);
    expect(fleet.reporter).toBeNull();
    await until(async () => ((await fleet.registry?.view()) ?? []).length > 0);
    const [shop] = (await fleet.registry?.view()) ?? [];
    expect(shop?.instances[0]).toMatchObject({ role: 'bullmq+durable', state: 'ready', url: null });
    // Health checks run without an HTTP route: they ride the heartbeat.
    expect(shop?.instances[0]?.checks.map((check) => check.name)).toEqual(['redis']);
    expect((await fleet.readiness()).role).toBe('bullmq+durable');

    await fleet.beforeApplicationShutdown();
    const [after] = (await fleet.registry?.view()) ?? [];
    expect(after?.counts.draining).toBe(1);
  });

  it('a short-lived context never becomes an instance', async () => {
    const app = await context({
      storage: new InMemoryStorageProvider(),
      fleet: { app: 'shop', workerAfter: 200 },
    });
    const fleet = app.get(TelescopeFleet);
    await sleep(20);
    opened.splice(opened.indexOf(app), 1);
    await app.close();
    await sleep(250);
    expect(fleet.reporter).toBeNull();
    expect(await fleet.registry?.view()).toEqual([]);
  });

  it('`fleet.role` reports right away under that name', async () => {
    const app = await context({
      storage: new InMemoryStorageProvider(),
      fleet: { app: 'shop', role: 'durable:work' },
    });
    const fleet = app.get(TelescopeFleet);
    await until(async () => ((await fleet.registry?.view()) ?? []).length > 0);
    const [shop] = (await fleet.registry?.view()) ?? [];
    expect(shop?.instances[0]).toMatchObject({ role: 'durable:work', state: 'ready' });
  });

  it("`report: ['web']` keeps workers out", async () => {
    const app = await context({
      storage: new InMemoryStorageProvider(),
      fleet: { app: 'shop', report: ['web'], role: 'consumer' },
    });
    await sleep(30);
    expect(app.get(TelescopeFleet).reporter).toBeNull();
  });

  it('refuses an invalid role or report at boot', async () => {
    await expect(
      context({ storage: new InMemoryStorageProvider(), fleet: { role: 'has space' } }),
    ).rejects.toThrow(/fleet.role/);
    await expect(
      context({ storage: new InMemoryStorageProvider(), fleet: { report: ['cli' as 'web'] } }),
    ).rejects.toThrow(/fleet.report/);
  });
});

describe('workers through a control plane', () => {
  it('a tenant worker sends its role; its last heartbeat is draining', async () => {
    const storage = new InMemoryStorageProvider();
    const cp = await web(
      {
        topology: 'control-plane',
        verifyTenant: hmacTenantVerifier(SECRET),
        storage,
        fleet: { app: 'ops' },
      },
      true,
    );
    const address = (cp as INestApplication).getHttpServer().address() as AddressInfo;
    const worker = await context({
      topology: 'tenant',
      tenant: {
        url: `http://127.0.0.1:${address.port}/telescope`,
        partition: 'shop',
        token: signTenantToken('shop', SECRET),
        intervalMs: 10,
      },
      fleet: { role: 'durable:work' },
    });
    const view = async () =>
      (await request((cp as INestApplication).getHttpServer()).get('/telescope/api/fleet')).body;
    await until(async () => (await view()).apps.some((a: { app: string }) => a.app === 'shop'));
    const shop = (await view()).apps.find((a: { app: string }) => a.app === 'shop');
    expect(shop.instances[0].role).toBe('durable:work');
    expect(shop.roles.map((r: { role: string }) => r.role)).toEqual(['durable:work']);
    opened.splice(opened.indexOf(worker), 1);
    await worker.close();
    const after = (await view()).apps.find((a: { app: string }) => a.app === 'shop');
    expect(after.counts.draining).toBe(1);
  });

  it('takes a heartbeat without a role (an older tenant) as web, and one with a junk role as web', async () => {
    const beats: Array<{ app: string; role: unknown }> = [];
    const handler = createIngestHandler({
      verifyTenant: hmacTenantVerifier(SECRET),
      store: async () => {},
      heartbeat: (app, heartbeat) => {
        beats.push({ app, role: (heartbeat as { role?: unknown }).role });
      },
    });
    const beat = (extra: Record<string, unknown>) => ({
      v: 1,
      instanceId: `i-${beats.length}`,
      host: 'h',
      pid: 1,
      version: null,
      bootedAt: new Date().toISOString(),
      sentAt: new Date().toISOString(),
      state: 'ready',
      intervalMs: 15_000,
      checks: [],
      shipping: null,
      ...extra,
    });
    const { normalizeHeartbeat } = await import('../../src/fleet/heartbeat.js');
    for (const extra of [{}, { role: 'bullmq' }, { role: 'no spaces allowed' }]) {
      await handler({
        token: signTenantToken('shop', SECRET),
        body: JSON.parse(JSON.stringify(ingestBatch([], new Date(), beat(extra)))),
      });
    }
    expect(beats.map((b) => normalizeHeartbeat(beat({ role: b.role }))?.role)).toEqual([
      'web',
      'bullmq',
      'web',
    ]);
  });
});
