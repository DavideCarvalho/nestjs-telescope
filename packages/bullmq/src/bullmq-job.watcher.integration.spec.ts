// packages/bullmq/src/bullmq-job.watcher.integration.spec.ts
//
// Integration: real @nestjs/bullmq wiring + real Redis + real TelescopeModule.
//
// Validates the LINCHPIN assumption of BullMqJobWatcher: @nestjs/bullmq resolves
// instance.process(job, token) at CALL-TIME per job, so the prototype patch the
// watcher applies during register() (at onApplicationBootstrap, AFTER workers are
// created at onModuleInit) still takes effect for jobs (which only run after the
// app has bootstrapped). This is the only path that exercises that timing against
// the real framework, rather than a mocked WorkerHost.
//
// REQUIRES Redis. Skipped via describe.skipIf(!process.env.REDIS_URL) so CI
// without Redis stays green and reports the suite as skipped (0 failures).
//
// Read path mirrors mikro-orm-query.watcher.integration.spec.ts exactly: flush
// the TelescopeService, then GET /telescope/api/entries via supertest and read
// the { data: Entry[] } response shape.
//
// Note: Vitest uses esbuild, which does NOT emit decorator metadata, so the
// processor relies only on @Processor() (handled by @nestjs/bullmq's own
// metadata, not reflection-based constructor DI) and has no injected deps.
//
import 'reflect-metadata';
import type { Entry } from '@dudousxd/nestjs-telescope';
import { TelescopeModule, TelescopeService } from '@dudousxd/nestjs-telescope';
import { BullModule, Processor, WorkerHost, getQueueToken } from '@nestjs/bullmq';
import { type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Job, Queue } from 'bullmq';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BullMqJobWatcher } from './bullmq-job.watcher.js';

const REDIS_URL = process.env.REDIS_URL;
const connection = REDIS_URL ? { url: REDIS_URL } : { host: '127.0.0.1', port: 6379 };

/** Narrow the loosely-typed job payload without `any` (esbuild-safe). */
function isBoom(data: unknown): boolean {
  return typeof data === 'object' && data !== null && (data as { boom?: unknown }).boom === true;
}

@Processor('telescope-test')
class TestProcessor extends WorkerHost {
  async process(job: Job): Promise<string> {
    if (isBoom(job.data)) throw new Error('intentional failure');
    return 'done';
  }
}

@Module({
  imports: [
    TelescopeModule.forRoot({
      enabled: true,
      authorizer: () => true,
      watchers: [new BullMqJobWatcher({ slowMs: 999999 })],
    }),
    BullModule.forRoot({ connection }),
    BullModule.registerQueue({ name: 'telescope-test' }),
  ],
  providers: [TestProcessor],
})
class AppModule {}

/** Poll up to ~5s (50 × 100ms): flush, GET entries, return the first matching
 *  job entry, or undefined if none appears within the budget. */
async function pollForJobEntry(
  app: INestApplication,
  predicate: (entry: Entry) => boolean,
): Promise<Entry | undefined> {
  const service = app.get(TelescopeService);
  for (let i = 0; i < 50; i++) {
    await service.flush();
    const res = await request(app.getHttpServer()).get('/telescope/api/entries');
    const entries: Entry[] = (res.body as { data: Entry[] }).data;
    const match = entries.find((entry) => entry.type === 'job' && predicate(entry));
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

describe.skipIf(!REDIS_URL)('BullMqJobWatcher integration (real Redis)', () => {
  let app: INestApplication;
  let queue: Queue;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await app.init();
    queue = moduleRef.get<Queue>(getQueueToken('telescope-test'));
  });

  afterAll(async () => {
    await queue?.obliterate({ force: true }).catch(() => {});
    await app?.close();
  });

  it('records a completed job entry correlated to a queue batch', async () => {
    await queue.add('greet', { hello: 'world' });

    const jobEntry = await pollForJobEntry(
      app,
      (entry) => (entry.content as { name?: string }).name === 'greet',
    );

    expect(jobEntry).toBeDefined();
    const completed = jobEntry as Entry;
    expect(completed.origin).toBe('queue');
    const content = completed.content as { status: string; queue: string; name: string };
    expect(content.status).toBe('completed');
    expect(content.queue).toBe('telescope-test');
    expect(content.name).toBe('greet');
  });

  it('records a failed job entry with a failure reason', async () => {
    await queue.add('boom', { boom: true });

    const jobEntry = await pollForJobEntry(
      app,
      (entry) => (entry.content as { name?: string }).name === 'boom',
    );

    expect(jobEntry).toBeDefined();
    const failed = jobEntry as Entry;
    const content = failed.content as { status: string; failureReason: string | null };
    expect(content.status).toBe('failed');
    expect(content.failureReason).not.toBeNull();
  });
});
