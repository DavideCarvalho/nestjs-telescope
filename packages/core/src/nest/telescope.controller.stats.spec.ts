// packages/core/src/nest/telescope.controller.stats.spec.ts
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeModule } from './telescope.module.js';

function queryEntry(createdAt: Date, durationMs: number): Entry {
  return {
    id: `q-${Math.random()}`,
    batchId: 'b',
    type: 'query',
    familyHash: 'fam-a',
    content: { sql: 'select 1', bindings: [], connection: null, slow: false },
    tags: [],
    sequence: 0,
    durationMs,
    origin: 'http',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt,
  };
}

describe('GET /telescope/api/stats', () => {
  let app: INestApplication;
  const storage = new InMemoryStorageProvider();

  beforeAll(async () => {
    const now = Date.now();
    await storage.store([
      queryEntry(new Date(now - 60_000), 10),
      queryEntry(new Date(now - 40_000), 30),
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

  it('returns per-type stats for type=query', async () => {
    const res = await request(app.getHttpServer())
      .get('/telescope/api/stats?type=query&window=1h')
      .expect(200);
    const body = res.body as { type: string; total: number };
    expect(body.type).toBe('query');
    expect(body.total).toBe(2);
  });

  it('rejects a missing type with 400', async () => {
    await request(app.getHttpServer()).get('/telescope/api/stats?window=1h').expect(400);
  });

  it('rejects an unparseable window with 400', async () => {
    await request(app.getHttpServer())
      .get('/telescope/api/stats?type=query&window=soon')
      .expect(400);
  });
});
