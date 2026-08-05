// packages/bullmq/src/bullmq-job.watcher.e2e.spec.ts
//
// End-to-end against a REAL app with the REAL `@nestjs/bullmq` explorer, minus
// Redis: `BullModule.workerClass` (a supported extension point, meant for
// BullMQ Pro's `WorkerPro`) swaps in a worker class that records the processor
// function it was constructed with instead of connecting to a broker. Everything
// else is real — `BullRegistrar.onModuleInit` → `BullExplorer.handleProcessor`
// binding and decorating the processor, a real `TelescopeModule` graph, real
// registration through `TelescopeWatcherRegistrar`, real storage, real trace
// context.
//
// WHY it is built this way: the previous version of this file called
// `processor.process(job)` by hand and passed, while a job driven by a real
// worker recorded NOTHING. `@nestjs/bullmq` binds a static processor once
// (`processor = instance['process'].bind(instance)`) at `onModuleInit`, so the
// watcher's prototype patch — applied at `onApplicationBootstrap` — was never
// seen again. The assertion that matters here is therefore not "the wrapper
// builds a nice entry" but "the function the FRAMEWORK handed the worker is
// ours". `bullmq-job.watcher.integration.spec.ts` closes the loop with a real
// Redis and a real worker draining a real queue.
//
// Note: Vitest uses esbuild, which does NOT emit decorator metadata, so the
// processor relies only on @Processor()'s own metadata and has no injected deps.
//
import 'reflect-metadata';
import {
  InMemoryStorageProvider,
  TelescopeModule,
  TelescopeService,
  type TraceContext,
  type TraceContextProvider,
} from '@dudousxd/nestjs-telescope';
import { BullModule, Processor, WorkerHost } from '@nestjs/bullmq';
import { Module, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BullMqJobWatcher } from './bullmq-job.watcher.js';
import { isInstrumentedProcessor } from './processor-instrumentation.js';

const storage = new InMemoryStorageProvider();
const watcher = new BullMqJobWatcher({ slowMs: 999999 });

/** A stand-in for `bullmq`'s `Worker` that keeps the processor the explorer
 *  built instead of talking to Redis. `processFn` is the exact field the real
 *  Worker reads on every job (`callProcessJob` → `this.processFn(job, token)`). */
class RecordingWorker {
  readonly processFn: (...args: unknown[]) => unknown;
  constructor(
    readonly name: string,
    processor: (...args: unknown[]) => unknown,
    readonly opts: unknown,
  ) {
    this.processFn = processor;
  }
  async close(): Promise<void> {}
  on(): this {
    return this;
  }
}

/** Likewise for the Queue the explorer looks up for its options — registering a
 *  queue is what pulls `BullExplorer`/`BullRegistrar` into the graph at all. */
class RecordingQueue {
  constructor(
    readonly name: string,
    readonly opts: unknown,
  ) {}
  async close(): Promise<void> {}
}

// Must be set before the @Module decorator below is evaluated: BullModule
// captures both classes when the module metadata is built.
BullModule.workerClass = RecordingWorker;
BullModule.queueClass = RecordingQueue;

/**
 * A real host-supplied `TraceContextProvider` that mints one trace id per
 * Telescope batch — what an OTel tracer wrapped around a job would produce: one
 * span per job execution. It resolves the batch from the live
 * `TelescopeService`, so an entry recorded OUTSIDE the job's batch scope gets a
 * null trace id, and two different jobs get two different ids. That is what
 * makes the "one trace, not two" assertion below mean something.
 */
let telescope: TelescopeService | undefined;
const traceContext: TraceContextProvider = {
  current(): TraceContext | null {
    const batch = telescope?.context.current();
    if (!batch) return null;
    const traceId = batch.id.replace(/-/g, '');
    return { traceId, spanId: traceId.slice(0, 16) };
  },
};

/** The BullMQ `Job` fields this processor and the watcher actually read. */
interface JobStub {
  id?: string;
  name?: string;
  queueName?: string;
  attemptsMade?: number;
  data?: { boom?: boolean; missing?: boolean };
}

@Processor('mail')
class MailProcessor extends WorkerHost {
  async process(job: JobStub): Promise<string> {
    if (job.data?.missing === true) throw new NotFoundException('no such user');
    if (job.data?.boom === true) throw new Error('SMTP down');
    return 'sent';
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
    BullModule.forRoot({ connection: { host: '127.0.0.1', port: 6379 } }),
    BullModule.registerQueue({ name: 'mail' }),
  ],
  providers: [MailProcessor],
})
class AppModule {}

/** Call the worker's processor the way BullMQ does, without claiming to know
 *  the private shape of `Worker`. */
function runJob(processor: MailProcessor, job: JobStub, token?: string): Promise<unknown> {
  const processFn: unknown = Reflect.get(processor.worker, 'processFn');
  if (typeof processFn !== 'function') throw new Error('the worker has no processFn');
  return Promise.resolve(processFn(job, token));
}

describe('BullMqJobWatcher end-to-end (real BullExplorer, real TelescopeModule)', () => {
  let app: TestingModule;
  let processor: MailProcessor;

  beforeAll(async () => {
    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    telescope = app.get(TelescopeService);
    processor = app.get(MailProcessor);
    await app.init();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  // THE regression assertion. The explorer captured its processor reference at
  // its own onModuleInit; if instrumentation ever moves back to register()
  // (onApplicationBootstrap) this is the raw bound method again and every
  // assertion below stops meaning anything.
  it('hands the worker Telescope’s wrapper, not the raw bound process()', () => {
    expect(isInstrumentedProcessor(Reflect.get(processor.worker, 'processFn'))).toBe(true);
    expect(watcher.instrumentedBeforeRegister).toBe(1);
  });

  it('records a completed job in its own queue batch', async () => {
    await expect(
      runJob(processor, { id: '1', name: 'send-welcome', queueName: 'mail' }, 'token-1'),
    ).resolves.toBe('sent');
    await telescope?.flush();

    const entries = (await storage.get({})).data;
    const jobEntry = entries.find(
      (entry) => entry.type === 'job' && entry.familyHash === 'mail:send-welcome',
    );
    expect(jobEntry).toBeDefined();
    expect(jobEntry?.origin).toBe('queue');
    expect(jobEntry?.traceId).not.toBeNull();
    expect(jobEntry?.content).toMatchObject({ status: 'completed', queue: 'mail' });
  }, 30_000);

  it('turns a job body throw into an exception entry sharing the job’s trace', async () => {
    await expect(
      runJob(processor, {
        id: '42',
        name: 'send-boom',
        queueName: 'mail',
        attemptsMade: 2,
        data: { boom: true },
      }),
    ).rejects.toThrow('SMTP down');
    await telescope?.flush();

    const entries = (await storage.get({})).data;
    const exception = entries.find((entry) => entry.type === 'exception');
    expect(exception).toBeDefined();
    expect(exception?.origin).toBe('queue');
    expect(exception?.familyHash).toMatch(/^Error:SMTP down:at /);
    expect(exception?.content).toMatchObject({
      class: 'Error',
      message: 'SMTP down',
      context: { queue: 'mail', job: 'send-boom', jobId: '42', attempts: 2 },
    });
    expect(exception?.tags).toEqual(expect.arrayContaining(['queue:mail', 'job:send-boom']));

    // One failure, one trace: the exception and the job it came from have to be
    // the same story in the dashboard, not two unrelated rows.
    const jobEntry = entries.find(
      (entry) => entry.type === 'job' && entry.batchId === exception?.batchId,
    );
    expect(jobEntry).toBeDefined();
    expect(exception?.traceId).not.toBeNull();
    expect(jobEntry?.traceId).toBe(exception?.traceId);
  }, 30_000);

  it('applies the shared 4xx skip end-to-end', async () => {
    await expect(
      runJob(processor, {
        id: '43',
        name: 'lookup',
        queueName: 'mail',
        attemptsMade: 1,
        data: { missing: true },
      }),
    ).rejects.toThrow('no such user');
    await telescope?.flush();

    const entries = (await storage.get({})).data;
    const lookupJob = entries.find(
      (entry) => entry.type === 'job' && entry.familyHash === 'mail:lookup',
    );
    // The failed job entry is still recorded — the 4xx is not lost, it just
    // doesn't spawn an exception family.
    expect(lookupJob).toBeDefined();
    expect(
      entries.filter((entry) => entry.type === 'exception' && entry.batchId === lookupJob?.batchId),
    ).toHaveLength(0);
  }, 30_000);
});
