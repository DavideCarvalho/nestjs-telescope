// packages/core/src/nest/telescope.controller.prunes.spec.ts
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeModule } from './telescope.module.js';
import type { TelescopeModuleOptions } from './telescope.options.js';

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

async function makeApp(options: TelescopeModuleOptions): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [TelescopeModule.forRoot(options)],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('GET /telescope/api/prunes', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('returns runs, the resolved config and a nextRunAt when prune is configured', async () => {
    app = await makeApp({
      enabled: true,
      authorizer: () => true,
      storage: new InMemoryStorageProvider(),
      prune: { after: '1h', keepLast: 50, intervalMs: 60_000, perType: { exception: '7d' } },
    });
    const res = await request(app.getHttpServer()).get('/telescope/api/prunes').expect(200);
    expect(res.body.config).toEqual({
      afterMs: 3_600_000,
      intervalMs: 60_000,
      keepLast: 50,
      perType: { exception: 604_800_000 },
    });
    expect(Array.isArray(res.body.runs)).toBe(true);
    expect(typeof res.body.nextRunAt).toBe('string');
  });

  it('returns null config and null nextRunAt when no prune window is configured', async () => {
    app = await makeApp({
      enabled: true,
      authorizer: () => true,
      storage: new InMemoryStorageProvider(),
    });
    const res = await request(app.getHttpServer()).get('/telescope/api/prunes').expect(200);
    expect(res.body).toEqual({ runs: [], config: null, nextRunAt: null });
  });

  it('records an on-demand prune as a manual run visible on /prunes', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.store([
      entry({ id: 'old', createdAt: new Date('2020-01-01T00:00:00Z') }),
      entry({ id: 'fresh', createdAt: new Date() }),
    ]);
    app = await makeApp({
      enabled: true,
      authorizer: () => true,
      authorizeAction: () => true,
      storage,
      prune: { after: '1h' },
    });
    await request(app.getHttpServer())
      .post('/telescope/api/retention/prune')
      .expect(200)
      .expect({ pruned: 1 });

    const res = await request(app.getHttpServer()).get('/telescope/api/prunes').expect(200);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0].trigger).toBe('manual');
    expect(res.body.runs[0].deletedTotal).toBe(1);
  });

  it('is gated by the read guard (403 when unauthorized)', async () => {
    app = await makeApp({
      enabled: true,
      authorizer: () => false,
      storage: new InMemoryStorageProvider(),
      prune: { after: '1h' },
    });
    await request(app.getHttpServer()).get('/telescope/api/prunes').expect(403);
  });
});
