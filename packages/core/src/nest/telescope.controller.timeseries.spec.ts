// packages/core/src/nest/telescope.controller.timeseries.spec.ts
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeModule } from './telescope.module.js';

function entry(type: string, createdAt: Date): Entry {
  return {
    id: `e-${Math.random()}`,
    batchId: 'b',
    type,
    familyHash: null,
    content: {},
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'i',
    createdAt,
  };
}

describe('GET /telescope/api/timeseries', () => {
  let app: INestApplication;
  const storage = new InMemoryStorageProvider();

  beforeAll(async () => {
    const now = Date.now();
    await storage.store([
      entry('request', new Date(now - 60_000)),
      entry('query', new Date(now - 50_000)),
      entry('request', new Date(now - 40_000)),
    ]);
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ enabled: true, authorizer: () => true, storage })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns the requested number of buckets', async () => {
    const res = await request(app.getHttpServer())
      .get('/telescope/api/timeseries?window=1h&buckets=12')
      .expect(200);
    const body = res.body as { buckets: unknown[] };
    expect(body.buckets).toHaveLength(12);
  });

  it('rejects an unparseable window with 400', async () => {
    await request(app.getHttpServer()).get('/telescope/api/timeseries?window=soon').expect(400);
  });
});
