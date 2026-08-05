// packages/bullmq/src/bullmq-job.watcher.integration.spec.ts
//
// The real thing: a real Redis, a real BullMQ `Worker` draining a real queue,
// real `@nestjs/bullmq` wiring, a real `TelescopeModule`. Nothing here invokes
// `process()` by hand — jobs are enqueued and the framework picks them up on its
// own schedule, which is the only way to prove the watcher instruments the
// handler that ACTUALLY runs.
//
// It has to be this suite, because everything cheaper missed the defect: the
// watcher used to patch the processor's prototype at `onApplicationBootstrap`,
// long after `BullExplorer` had bound `instance['process']` at `onModuleInit`,
// and a job driven by a real worker produced zero entries — no `job` entry, no
// exception, no batch. This file previously passed `connection: { url: REDIS_URL }`
// to BullMQ; ioredis `RedisOptions` has no `url` field, so it silently connected
// to localhost:6379 and never tested what its own header claimed.
//
// Redis comes from REDIS_URL if set, else a throwaway docker container; when
// neither is available the suite skips loudly (see test/redis-container.ts).
//
// Note: Vitest uses esbuild, which does NOT emit decorator metadata, so the
// processor relies only on @Processor() (handled by @nestjs/bullmq's own
// metadata, not reflection-based constructor DI) and has no injected deps.
//
import 'reflect-metadata';
import type { Entry } from '@dudousxd/nestjs-telescope';
import {
  InMemoryStorageProvider,
  TelescopeModule,
  TelescopeService,
  type TraceContext,
  type TraceContextProvider,
} from '@dudousxd/nestjs-telescope';
import { BullModule, Processor, WorkerHost, getQueueToken } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Job, Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRedis } from '../test/redis-container.js';
import { BullMqJobWatcher } from './bullmq-job.watcher.js';
import { isInstrumentedProcessor } from './processor-instrumentation.js';

// Top-level await: the connection has to be known before the module metadata
// below is built, and before describe.skipIf decides whether to run.
const redis = await startRedis();
const connection = redis?.connection ?? { host: '127.0.0.1', port: 6379 };

const storage = new InMemoryStorageProvider();
const watcher = new BullMqJobWatcher({ slowMs: 999999 });

let telescope: TelescopeService | undefined;
/** One trace id per Telescope batch — an entry recorded outside a job's batch
 *  scope gets none, which is what makes the trace assertions mean something. */
const traceContext: TraceContextProvider = {
  current(): TraceContext | null {
    const batch = telescope?.context.current();
    if (!batch) return null;
    const traceId = batch.id.replace(/-/g, '');
    return { traceId, spanId: traceId.slice(0, 16) };
  },
};

/** Narrow the loosely-typed job payload without `any` (esbuild-safe). */
function isBoom(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false;
  return Reflect.get(data, 'boom') === true;
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
      storage,
      traceContext,
      watchers: [watcher],
    }),
    BullModule.forRoot({ connection }),
    BullModule.registerQueue({ name: 'telescope-test' }),
  ],
  providers: [TestProcessor],
})
class AppModule {}

/** Poll up to ~15s for an entry the worker produces on its own. */
async function pollForEntry(predicate: (entry: Entry) => boolean): Promise<Entry | undefined> {
  for (let i = 0; i < 150; i++) {
    await telescope?.flush();
    const match = (await storage.get({})).data.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

function named(entry: Entry, name: string): boolean {
  if (typeof entry.content !== 'object' || entry.content === null) return false;
  return Reflect.get(entry.content, 'name') === name;
}

describe.skipIf(!redis)(`BullMqJobWatcher integration (real Redis: ${redis?.describedAs})`, () => {
  let app: TestingModule;
  let queue: Queue;
  let processor: TestProcessor;

  beforeAll(async () => {
    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    telescope = app.get(TelescopeService);
    processor = app.get(TestProcessor);
    await app.init();
    queue = app.get<Queue>(getQueueToken('telescope-test'));
    await queue.obliterate({ force: true }).catch(() => {});
  }, 120_000);

  afterAll(async () => {
    await queue?.obliterate({ force: true }).catch(() => {});
    await app?.close();
    await redis?.stop();
  }, 60_000);

  // THE regression assertion, against the real explorer and the real Worker:
  // this is the function BullMQ calls for every job. Move instrumentation back
  // to register() and it is the raw bound `process` again.
  it('gives the real Worker Telescope’s wrapper, not the raw bound process()', () => {
    expect(isInstrumentedProcessor(Reflect.get(processor.worker, 'processFn'))).toBe(true);
    expect(watcher.instrumentedBeforeRegister).toBe(1);
  });

  it('records a completed job entry, correlated to a queue batch with a trace', async () => {
    await queue.add('greet', { hello: 'world' });

    const jobEntry = await pollForEntry((entry) => entry.type === 'job' && named(entry, 'greet'));

    expect(jobEntry).toBeDefined();
    expect(jobEntry?.origin).toBe('queue');
    expect(jobEntry?.traceId).not.toBeNull();
    expect(jobEntry?.content).toMatchObject({
      status: 'completed',
      queue: 'telescope-test',
      name: 'greet',
    });
  }, 60_000);

  it('records a failed job entry and an exception entry sharing its trace', async () => {
    await queue.add('boom', { boom: true }, { attempts: 1 });

    const failed = await pollForEntry((entry) => entry.type === 'job' && named(entry, 'boom'));
    expect(failed).toBeDefined();
    expect(failed?.content).toMatchObject({ status: 'failed' });
    expect(Reflect.get(failed?.content ?? {}, 'failureReason')).not.toBeNull();

    const exception = await pollForEntry(
      (entry) => entry.type === 'exception' && entry.batchId === failed?.batchId,
    );
    expect(exception).toBeDefined();
    expect(exception?.origin).toBe('queue');
    expect(exception?.familyHash).toMatch(/^Error:intentional failure:at /);
    expect(exception?.content).toMatchObject({
      class: 'Error',
      message: 'intentional failure',
      context: { queue: 'telescope-test', job: 'boom' },
    });
    // One failure, one trace — not a job entry here and an orphan exception there.
    expect(exception?.traceId).not.toBeNull();
    expect(exception?.traceId).toBe(failed?.traceId);
  }, 60_000);
});
