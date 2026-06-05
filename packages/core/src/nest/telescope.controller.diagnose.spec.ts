// packages/core/src/nest/telescope.controller.diagnose.spec.ts
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiagnoseContext, ExceptionDiagnoser } from '../ai/diagnoser.js';
import type { ExceptionContent } from '../entry/content.js';
import { type Entry, EntryType } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeModule } from './telescope.module.js';
import type { TelescopeModuleOptions } from './telescope.options.js';

function exceptionEntry(id: string, content: Partial<ExceptionContent> = {}): Entry {
  return {
    id,
    batchId: `batch-${id}`,
    type: EntryType.Exception,
    familyHash: `fam-${id}`,
    content: { class: 'TypeError', message: 'boom', stack: 'TypeError: boom\n  at a', ...content },
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
}

/** A diagnoser resolving with a fixed markdown and counting its calls. */
function countingDiagnoser(
  markdown = '## Probable root cause\nA null deref.',
): ExceptionDiagnoser & {
  calls: DiagnoseContext[];
} {
  const calls: DiagnoseContext[] = [];
  return {
    calls,
    async diagnose(context: DiagnoseContext): Promise<string> {
      calls.push(context);
      return markdown;
    },
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

describe('POST /telescope/api/exceptions/:id/diagnose', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('is 404 when no `ai` is configured', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.store([exceptionEntry('e1')]);
    app = await makeApp({ enabled: true, authorizer: () => true, storage });
    await request(app.getHttpServer()).post('/telescope/api/exceptions/e1/diagnose').expect(404);
  });

  it('is 403 when the dashboard read guard denies (auth-gated)', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.store([exceptionEntry('e1')]);
    app = await makeApp({
      enabled: true,
      authorizer: () => false,
      storage,
      ai: { diagnoser: countingDiagnoser() },
    });
    await request(app.getHttpServer()).post('/telescope/api/exceptions/e1/diagnose').expect(403);
  });

  it('is 404 for an unknown / non-exception entry', async () => {
    const storage = new InMemoryStorageProvider();
    app = await makeApp({
      enabled: true,
      authorizer: () => true,
      storage,
      ai: { diagnoser: countingDiagnoser() },
    });
    await request(app.getHttpServer()).post('/telescope/api/exceptions/nope/diagnose').expect(404);
  });

  it('returns the markdown and caches the family (cache miss then hit)', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.store([exceptionEntry('e1')]);
    const diagnoser = countingDiagnoser('## root cause\nx');
    app = await makeApp({
      enabled: true,
      authorizer: () => true,
      storage,
      ai: { diagnoser },
    });
    const first = await request(app.getHttpServer())
      .post('/telescope/api/exceptions/e1/diagnose')
      .expect(200);
    expect(first.body).toEqual({ markdown: '## root cause\nx', cached: false });

    const second = await request(app.getHttpServer())
      .post('/telescope/api/exceptions/e1/diagnose')
      .expect(200);
    expect(second.body).toEqual({ markdown: '## root cause\nx', cached: true });
    expect(diagnoser.calls).toHaveLength(1);
  });

  it('force=true bypasses the cache and re-runs', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.store([exceptionEntry('e1')]);
    const diagnoser = countingDiagnoser();
    app = await makeApp({
      enabled: true,
      authorizer: () => true,
      storage,
      ai: { diagnoser },
    });
    await request(app.getHttpServer()).post('/telescope/api/exceptions/e1/diagnose').expect(200);
    const forced = await request(app.getHttpServer())
      .post('/telescope/api/exceptions/e1/diagnose?force=true')
      .expect(200);
    expect((forced.body as { cached: boolean }).cached).toBe(false);
    expect(diagnoser.calls).toHaveLength(2);
  });

  it('maps a diagnoser failure to a safe 502 (no model internals leaked)', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.store([exceptionEntry('e1')]);
    const diagnoser: ExceptionDiagnoser = {
      diagnose: () => Promise.reject(new Error('secret provider internals')),
    };
    app = await makeApp({
      enabled: true,
      authorizer: () => true,
      storage,
      ai: { diagnoser },
    });
    const res = await request(app.getHttpServer())
      .post('/telescope/api/exceptions/e1/diagnose')
      .expect(503);
    expect((res.body as { message: string }).message).toBe('AI diagnosis failed.');
  });

  it('diagnoses a client_exception too', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.store([
      {
        ...exceptionEntry('c1'),
        type: EntryType.ClientException,
        content: { name: 'TypeError', message: 'frontend boom', url: 'https://x.test/p' },
      },
    ]);
    const diagnoser = countingDiagnoser('## client cause');
    app = await makeApp({
      enabled: true,
      authorizer: () => true,
      storage,
      ai: { diagnoser },
    });
    const res = await request(app.getHttpServer())
      .post('/telescope/api/exceptions/c1/diagnose')
      .expect(200);
    expect((res.body as { markdown: string }).markdown).toBe('## client cause');
    expect(diagnoser.calls[0]?.client).toBe(true);
  });
});

describe('GET /telescope/api/meta — aiEnabled', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('reports ai.enabled=false when unconfigured', async () => {
    app = await makeApp({ enabled: true, authorizer: () => true });
    const res = await request(app.getHttpServer()).get('/telescope/api/meta').expect(200);
    expect(res.body.ai).toEqual({ enabled: false, mode: null });
  });

  it('reports ai.enabled=true and the mode when configured', async () => {
    app = await makeApp({
      enabled: true,
      authorizer: () => true,
      ai: { diagnoser: countingDiagnoser(), mode: 'auto' },
    });
    const res = await request(app.getHttpServer()).get('/telescope/api/meta').expect(200);
    expect(res.body.ai).toEqual({ enabled: true, mode: 'auto' });
  });
});
