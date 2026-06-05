// packages/core/src/nest/telescope.controller.retention.spec.ts
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

describe('GET /telescope/api/retention', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('returns the resolved retention window when prune is configured', async () => {
    app = await makeApp({
      enabled: true,
      authorizer: () => true,
      storage: new InMemoryStorageProvider(),
      prune: { after: '1h', keepLast: 100 },
    });
    const res = await request(app.getHttpServer()).get('/telescope/api/retention').expect(200);
    expect(res.body).toEqual({
      retention: { afterMs: 3_600_000, keepLast: 100 },
      entryCount: null,
      oldestCreatedAt: null,
      pruneSupported: true,
    });
  });

  it('returns null retention when no prune is configured', async () => {
    app = await makeApp({
      enabled: true,
      authorizer: () => true,
      storage: new InMemoryStorageProvider(),
    });
    const res = await request(app.getHttpServer()).get('/telescope/api/retention').expect(200);
    expect(res.body).toEqual({
      retention: null,
      entryCount: null,
      oldestCreatedAt: null,
      pruneSupported: true,
    });
  });

  it('is gated by the read guard (403 when unauthorized)', async () => {
    app = await makeApp({
      enabled: true,
      authorizer: () => false,
      storage: new InMemoryStorageProvider(),
    });
    await request(app.getHttpServer()).get('/telescope/api/retention').expect(403);
  });
});

describe('POST /telescope/api/retention/prune', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('is 403 by default when no authorizeAction is configured', async () => {
    app = await makeApp({
      enabled: true,
      authorizer: () => true,
      storage: new InMemoryStorageProvider(),
      prune: { after: '1h' },
    });
    await request(app.getHttpServer()).post('/telescope/api/retention/prune').expect(403);
  });

  it('is 400 when no prune window is configured', async () => {
    app = await makeApp({
      enabled: true,
      authorizer: () => true,
      authorizeAction: () => true,
      storage: new InMemoryStorageProvider(),
    });
    await request(app.getHttpServer()).post('/telescope/api/retention/prune').expect(400);
  });

  it('prunes old entries and returns the count', async () => {
    const storage = new InMemoryStorageProvider();
    // One ancient entry (older than the window) plus one fresh entry.
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
    const res = await request(app.getHttpServer())
      .post('/telescope/api/retention/prune')
      .expect(200);
    expect(res.body).toEqual({ pruned: 1 });
    const page = await storage.get({});
    expect(page.data.map((e) => e.id)).toEqual(['fresh']);
  });
});
