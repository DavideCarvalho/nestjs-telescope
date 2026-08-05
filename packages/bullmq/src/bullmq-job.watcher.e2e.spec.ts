// packages/bullmq/src/bullmq-job.watcher.e2e.spec.ts
//
// End-to-end against a REAL app: a real `TelescopeModule` graph (real
// TelescopeWatcherRegistrar discovering the watcher, real Recorder, real
// storage, real trace-context provider) and a real `@Processor`/`WorkerHost`
// subclass discovered through NestJS `DiscoveryService`. Nothing about Telescope
// is stubbed — the assertions read entries out of the storage the module was
// given.
//
// WHY this exists on top of the unit spec: the unit spec drives a hand-rolled
// WatcherContext, so it proves the wrapper builds the right entry but not that
// the wrapper is wired into a real app at all. "The watcher is never reached" is
// exactly how this change would fail silently.
//
// ONE deviation from production, and it is deliberate: `process` is invoked
// directly rather than by a BullMQ worker draining a queue. `@nestjs/bullmq`'s
// `BullRegistrar.onModuleInit` → `BullExplorer.handleProcessor` binds a static
// processor eagerly (`processor = instance['process'].bind(instance)`,
// bull.explorer.js), and Telescope registers its watchers at
// onApplicationBootstrap — always later. So a queue-driven job calls the
// ORIGINAL method and the prototype patch never sees it. That is a pre-existing
// limitation of this watcher's instrumentation strategy: it predates exception
// capture and suppresses the `job` entry too, not just the exception. Out of
// scope here; called out so nobody reads this file as proof that queue-driven
// jobs are captured. `bullmq-job.watcher.integration.spec.ts` is the suite that
// would prove that, and it does not pass today.
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
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Module, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BullMqJobWatcher } from './bullmq-job.watcher.js';

const storage = new InMemoryStorageProvider();

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

/** The BullMQ `Job` fields this processor and the watcher actually read. Every
 *  field is optional so the override stays assignable to `WorkerHost.process`. */
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
      watchers: [new BullMqJobWatcher({ slowMs: 999999 })],
    }),
  ],
  providers: [MailProcessor],
})
class AppModule {}

describe('BullMqJobWatcher end-to-end (real TelescopeModule graph)', () => {
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

  it('turns a job body throw into an exception entry sharing the job’s trace', async () => {
    await expect(
      processor.process({
        id: '42',
        name: 'send-welcome',
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
      context: { queue: 'mail', job: 'send-welcome', jobId: '42', attempts: 2 },
    });
    expect(exception?.tags).toEqual(expect.arrayContaining(['queue:mail', 'job:send-welcome']));

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
      processor.process({
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
