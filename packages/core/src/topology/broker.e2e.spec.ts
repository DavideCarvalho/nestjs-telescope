// Brokers wired through TelescopeModule: a control plane consumes its broker and keeps the HTTP
// ingest route; a broker tenant ships to the broker, including at shutdown.
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeRedis } from '../../test/topology/transport-fakes.js';
import { EntryType } from '../entry/entry.js';
import { TelescopeModule } from '../nest/telescope.module.js';
import type { TelescopeModuleOptions } from '../nest/telescope.options.js';
import { TelescopeService } from '../nest/telescope.service.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { hmacTenantVerifier, signTenantToken } from './tenant-auth.js';
import { transports } from './transports/index.js';
import { ingestBatch } from './wire.js';

const SECRET = 'cp-secret';
const apps: INestApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.close();
});

async function boot(options: TelescopeModuleOptions): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [TelescopeModule.forRoot({ authorize: () => true, ...options })],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  apps.push(app);
  await app.init();
  return app;
}

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out');
};

describe('broker topology', () => {
  it('a broker tenant and an HTTP tenant land in one control plane store', async () => {
    const redis = fakeRedis();
    const storage = new InMemoryStorageProvider();
    const cp = await boot({
      topology: 'control-plane',
      verifyTenant: hmacTenantVerifier(SECRET),
      storage,
      transport: transports.redis({ client: redis.client, pollMs: 5 }),
    });

    // A broker tenant: shuts down, flushing to the broker.
    const tenant = await boot({
      topology: 'tenant',
      tenant: {
        partition: 'billing',
        token: signTenantToken('billing', SECRET),
        transport: transports.redis({ client: redis.client }),
      },
    });
    const service = tenant.get(TelescopeService);
    service.record({ type: EntryType.Log, content: { level: 'info', message: 'from billing' } });
    apps.splice(apps.indexOf(tenant), 1);
    await tenant.close();

    // An HTTP tenant posts to the ingest route, still mounted on a broker control plane.
    const batch = ingestBatch([
      {
        id: 'http-1',
        batchId: 'b',
        type: 'log',
        familyHash: null,
        content: { message: 'from shop' },
        tags: [],
        sequence: 0,
        durationMs: null,
        origin: 'manual',
        instanceId: 'x',
        traceId: null,
        spanId: null,
        createdAt: new Date(),
      },
    ]);
    await request(cp.getHttpServer())
      .post('/telescope/api/ingest')
      .set('authorization', `Bearer ${signTenantToken('shop', SECRET)}`)
      .send(batch)
      .expect(202);

    await until(async () => (await storage.get({})).data.length === 2);
    const tags = (await storage.get({})).data.map((e) => e.tags.find((t) => t.startsWith('app:')));
    expect(tags.sort()).toEqual(['app:billing', 'app:shop']);
    // The client-error beacon stays on HTTP too (404 here only because it is not enabled).
    await request(cp.getHttpServer()).post('/telescope/api/client-errors').send({}).expect(404);
  }, 15_000);

  it('a broker that is down (or hangs) at boot never keeps HTTP ingest from serving; the consumer starts once it is back', async () => {
    const storage = new InMemoryStorageProvider();
    const redis = fakeRedis();
    redis.setDown(true);
    const real = transports.redis({ client: redis.client, pollMs: 5 });
    let attempts = 0;
    const flaky = {
      ...real,
      kind: 'redis',
      listen: async (...args: Parameters<NonNullable<typeof real.listen>>) => {
        attempts += 1;
        if (attempts === 1) throw new Error('ECONNREFUSED');
        return (real.listen as NonNullable<typeof real.listen>)(...args);
      },
    };
    const hanging = { ...flaky, listen: () => new Promise<never>(() => {}) };
    // A hanging connect: the app still boots and serves HTTP ingest.
    const stuck = await boot({
      topology: 'control-plane',
      verifyTenant: hmacTenantVerifier(SECRET),
      storage: new InMemoryStorageProvider(),
      transport: hanging,
    });
    await request(stuck.getHttpServer())
      .post('/telescope/api/ingest')
      .set('authorization', `Bearer ${signTenantToken('shop', SECRET)}`)
      .send(ingestBatch([]))
      .expect(202);

    // A refused connect is retried; once Redis is back, broker batches are consumed.
    const cp = await boot({
      topology: 'control-plane',
      verifyTenant: hmacTenantVerifier(SECRET),
      storage,
      transport: flaky,
    });
    await request(cp.getHttpServer())
      .post('/telescope/api/ingest')
      .set('authorization', `Bearer ${signTenantToken('shop', SECRET)}`)
      .send(ingestBatch([]))
      .expect(202);
    redis.setDown(false);
    await until(async () => attempts >= 2);
    const tenant = transports.redis({ client: redis.client });
    await tenant.send(
      ingestBatch([
        {
          id: 'late-1',
          batchId: 'b',
          type: 'log',
          familyHash: null,
          content: {},
          tags: [],
          sequence: 0,
          durationMs: null,
          origin: 'manual',
          instanceId: 'x',
          traceId: null,
          spanId: null,
          createdAt: new Date(),
        },
      ]),
      { token: signTenantToken('billing', SECRET), partition: 'billing' },
    );
    await until(async () => (await storage.get({})).data.length === 1);
  }, 15_000);
});
