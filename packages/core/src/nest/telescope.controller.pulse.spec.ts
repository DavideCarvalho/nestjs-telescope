// packages/core/src/nest/telescope.controller.pulse.spec.ts
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeModule } from './telescope.module.js';

function entry(type: string, content: unknown, durationMs: number | null): Entry {
  return {
    id: `e-${Math.random()}`,
    batchId: 'b',
    type,
    familyHash: type === 'exception' ? 'Error:boom' : null,
    content,
    tags: [],
    sequence: 0,
    durationMs,
    origin: 'http',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt: new Date(),
  };
}

describe('GET /telescope/api/pulse', () => {
  let app: INestApplication;
  const storage = new InMemoryStorageProvider();

  beforeAll(async () => {
    await storage.store([
      entry('query', { sql: 'select 1' }, 300),
      entry('request', { uri: '/a', method: 'GET' }, 50),
      entry('exception', { class: 'Error', message: 'boom' }, null),
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

  it('returns a health summary for the default window', async () => {
    const res = await request(app.getHttpServer()).get('/telescope/api/pulse').expect(200);
    const body = res.body as {
      counts: Record<string, number>;
      slowest: Array<{ durationMs: number }>;
      scanned: number;
    };
    expect(body.counts).toMatchObject({ query: 1, request: 1, exception: 1 });
    expect(body.slowest[0]!.durationMs).toBe(300);
    expect(body.scanned).toBe(3);
  });

  it('accepts a window query param', async () => {
    const res = await request(app.getHttpServer())
      .get('/telescope/api/pulse?window=15m')
      .expect(200);
    expect((res.body as { windowMs: number }).windowMs).toBe(900_000);
  });

  it('rejects an unparseable window with 400', async () => {
    await request(app.getHttpServer()).get('/telescope/api/pulse?window=soon').expect(400);
  });

  it('rejects a non-positive window with 400', async () => {
    await request(app.getHttpServer()).get('/telescope/api/pulse?window=0s').expect(400);
  });
});
