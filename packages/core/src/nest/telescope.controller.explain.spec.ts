// packages/core/src/nest/telescope.controller.explain.spec.ts
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryContent } from '../entry/content.js';
import { type Entry, EntryType } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeModule } from './telescope.module.js';
import type { TelescopeModuleOptions } from './telescope.options.js';

function queryEntry(id: string, content: Partial<QueryContent>): Entry {
  return {
    id,
    batchId: 'b',
    type: EntryType.Query,
    familyHash: null,
    content: { sql: 'select 1', bindings: [], connection: null, slow: false, ...content },
    tags: [],
    sequence: 0,
    durationMs: 1,
    origin: 'http',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
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

describe('POST /telescope/api/queries/explain', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('is 404 when no explainQuery hook is configured', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.store([queryEntry('q1', { sql: 'select * from users' })]);
    app = await makeApp({ enabled: true, authorizer: () => true, storage });
    await request(app.getHttpServer())
      .post('/telescope/api/queries/explain')
      .send({ entryId: 'q1' })
      .expect(404);
  });

  it('is 404 for an unknown / non-query entry', async () => {
    const storage = new InMemoryStorageProvider();
    app = await makeApp({
      enabled: true,
      authorizer: () => true,
      storage,
      explainQuery: () => Promise.resolve({ plan: 'x' }),
    });
    await request(app.getHttpServer())
      .post('/telescope/api/queries/explain')
      .send({ entryId: 'nope' })
      .expect(404);
  });

  it('runs the hook with the captured sql + bindings and returns the plan', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.store([
      queryEntry('q1', { sql: 'select * from users where id = ?', bindings: [42] }),
    ]);
    const explainQuery = vi.fn(() => Promise.resolve({ query_block: { cost: '1.0' } }));
    app = await makeApp({
      enabled: true,
      authorizer: () => true,
      storage,
      explainQuery: explainQuery as unknown as (
        sql: string,
        bindings: unknown[],
      ) => Promise<unknown>,
    });
    const res = await request(app.getHttpServer())
      .post('/telescope/api/queries/explain')
      .send({ entryId: 'q1' })
      .expect(200);
    expect(res.body).toEqual({ plan: { query_block: { cost: '1.0' } } });
    expect(explainQuery).toHaveBeenCalledWith('select * from users where id = ?', [42]);
  });

  it('surfaces a hook throw as a clean { message } error', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.store([queryEntry('q1', { sql: 'select * from users' })]);
    app = await makeApp({
      enabled: true,
      authorizer: () => true,
      storage,
      explainQuery: () => Promise.reject(new Error('connection refused')),
    });
    const res = await request(app.getHttpServer())
      .post('/telescope/api/queries/explain')
      .send({ entryId: 'q1' })
      .expect(503);
    expect((res.body as { message: string }).message).toBe('connection refused');
  });
});
