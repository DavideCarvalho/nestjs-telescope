// packages/core/src/nest/telescope.controller.traces.spec.ts
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import type { TraceSummary } from '../metrics/traces.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeModule } from './telescope.module.js';

function entry(type: string, traceId: string | null, createdAt: Date): Entry {
  return {
    id: `e-${Math.random()}`,
    batchId: 'b',
    type,
    familyHash: null,
    content: {},
    tags: [],
    sequence: 0,
    durationMs: 5,
    origin: 'http',
    instanceId: 'i',
    traceId,
    spanId: null,
    createdAt,
  };
}

describe('GET /telescope/api/traces', () => {
  let app: INestApplication;
  const storage = new InMemoryStorageProvider();

  beforeAll(async () => {
    const now = Date.now();
    await storage.store([
      entry('request', 't1', new Date(now - 60_000)),
      entry('query', 't1', new Date(now - 59_000)),
      entry('request', 't2', new Date(now - 40_000)),
      entry('request', null, new Date(now - 30_000)),
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

  it('returns distinct traces grouped by traceId, null-trace excluded', async () => {
    const res = await request(app.getHttpServer())
      .get('/telescope/api/traces?window=1h')
      .expect(200);
    const body = res.body as { traces: TraceSummary[] };
    expect(body.traces.map((t) => t.traceId)).toEqual(['t2', 't1']);
    const t1 = body.traces.find((t) => t.traceId === 't1');
    expect(t1?.entryCount).toBe(2);
    expect(t1?.types).toEqual(['query', 'request']);
  });

  it('applies the limit query param', async () => {
    const res = await request(app.getHttpServer())
      .get('/telescope/api/traces?window=1h&limit=1')
      .expect(200);
    const body = res.body as { traces: TraceSummary[] };
    expect(body.traces).toHaveLength(1);
  });

  it('rejects an unparseable window with 400', async () => {
    await request(app.getHttpServer()).get('/telescope/api/traces?window=soon').expect(400);
  });
});
