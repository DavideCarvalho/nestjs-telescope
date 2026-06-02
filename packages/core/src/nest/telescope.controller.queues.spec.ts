// packages/core/src/nest/telescope.controller.queues.spec.ts
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeModule } from './telescope.module.js';

function jobEntry(queue: string): Entry {
  return {
    id: `${queue}-${Math.random()}`,
    batchId: 'b',
    type: 'job',
    familyHash: `${queue}:x`,
    content: { queue, status: 'completed', waitMs: 5 },
    tags: [],
    sequence: 0,
    durationMs: 100,
    origin: 'queue',
    instanceId: 'i',
    createdAt: new Date(),
  };
}

describe('GET /telescope/api/queues', () => {
  let app: INestApplication;
  const storage = new InMemoryStorageProvider();

  beforeAll(async () => {
    await storage.store([jobEntry('mail'), jobEntry('mail'), jobEntry('reports')]);
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ enabled: true, authorizer: () => true, storage })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns per-queue metrics for the default window', async () => {
    const res = await request(app.getHttpServer()).get('/telescope/api/queues').expect(200);
    const body = res.body as { queues: Array<{ queue: string; total: number }>; scanned: number };
    expect(body.queues.map((q) => q.queue)).toEqual(['mail', 'reports']);
    expect(body.queues[0]!.total).toBe(2);
    expect(body.scanned).toBe(3);
  });

  it('accepts a window query param', async () => {
    const res = await request(app.getHttpServer())
      .get('/telescope/api/queues?window=15m')
      .expect(200);
    expect((res.body as { windowMs: number }).windowMs).toBe(900_000);
  });

  it('rejects an unparseable window with 400', async () => {
    await request(app.getHttpServer()).get('/telescope/api/queues?window=soon').expect(400);
  });

  it('rejects a non-positive window with 400', async () => {
    await request(app.getHttpServer()).get('/telescope/api/queues?window=0s').expect(400);
  });
});
