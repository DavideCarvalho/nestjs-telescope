// packages/schedule/src/schedule.watcher.integration.spec.ts
//
// End-to-end against a REAL app: a real `TelescopeModule` graph (real Recorder,
// real storage, real trace-context provider, real watcher registration through
// TelescopeWatcherRegistrar) plus a real `ScheduleModule` and a real `@Cron`
// provider. Nothing about Telescope is stubbed — the assertions read entries out
// of the storage the module was given.
//
// WHY this exists on top of the unit spec: the unit spec drives a hand-rolled
// WatcherContext, so it proves the wrapper builds the right entry but not that
// the wrapper is wired into a real app at all. "The watcher is never reached" is
// exactly how this change would fail silently.
//
// ONE deviation from production, and it is deliberate: the task is invoked
// directly rather than by the cron timer. `@nestjs/schedule`'s explorer captures
// `instance[method]` during its OWN onModuleInit, which runs BEFORE Telescope's
// watcher registration (`TelescopeWatcherRegistrar` registers at
// onApplicationBootstrap, and even at onModuleInit the explorer still wins the
// ordering — measured, with Telescope imported first). So the cron timer calls
// the ORIGINAL method and the ScheduleWatcher's prototype patch never sees a
// timer-driven run. That is a pre-existing limitation of this watcher's
// instrumentation strategy — it predates exception capture and suppresses the
// `job` entry too, not just the exception — and fixing it means changing HOW the
// watcher instruments (it would also have to carry `@nestjs/schedule`'s
// SCHEDULER_* metadata onto its wrapper, or the task would stop being scheduled
// at all). Out of scope here; called out so nobody reads this file as proof that
// timer-driven crons are captured.
//
// Note: Vitest uses esbuild, which does NOT emit decorator metadata, so the task
// provider relies only on `@Cron`'s own explicit metadata and has no injected
// constructor deps.
//
import 'reflect-metadata';
import {
  InMemoryStorageProvider,
  TelescopeModule,
  TelescopeService,
  type TraceContext,
  type TraceContextProvider,
} from '@dudousxd/nestjs-telescope';
import { Injectable, Module, NotFoundException } from '@nestjs/common';
import { Cron, ScheduleModule } from '@nestjs/schedule';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScheduleWatcher } from './schedule.watcher.js';

const storage = new InMemoryStorageProvider();

/**
 * A real host-supplied `TraceContextProvider` that mints one trace id per
 * Telescope batch — what an OTel tracer wrapped around a scheduled run would
 * produce: one span per run. It resolves the batch from the live
 * `TelescopeService`, so an entry recorded OUTSIDE the run's batch scope gets a
 * null trace id, and two different runs get two different ids. That is what
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

@Injectable()
class ReportTask {
  // A schedule far enough out that the timer never fires during the test — the
  // run is driven explicitly (see the header).
  @Cron('0 0 5 1 1 *', { name: 'nightly-report' })
  async run(): Promise<never> {
    throw new TypeError('report generator blew up');
  }

  @Cron('0 0 5 1 1 *', { name: 'sync-missing' })
  async sync(): Promise<never> {
    throw new NotFoundException('nothing to sync');
  }
}

@Module({
  imports: [
    TelescopeModule.forRoot({
      enabled: true,
      authorizer: () => true,
      storage,
      traceContext,
      watchers: [new ScheduleWatcher({ slowMs: 999999 })],
    }),
    ScheduleModule.forRoot(),
  ],
  providers: [ReportTask],
})
class AppModule {}

describe('ScheduleWatcher end-to-end (real TelescopeModule + ScheduleModule)', () => {
  let app: TestingModule;
  let task: ReportTask;

  beforeAll(async () => {
    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    telescope = app.get(TelescopeService);
    task = app.get(ReportTask);
    await app.init();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it('turns a scheduled throw into an exception entry sharing the run’s trace', async () => {
    await expect(task.run()).rejects.toThrow('report generator blew up');
    await telescope?.flush();

    const entries = (await storage.get({})).data;
    const exception = entries.find((entry) => entry.type === 'exception');
    expect(exception).toBeDefined();
    expect(exception?.origin).toBe('schedule');
    expect(exception?.familyHash).toMatch(/^TypeError:report generator blew up:at /);
    expect(exception?.content).toMatchObject({
      class: 'TypeError',
      message: 'report generator blew up',
      context: { task: 'nightly-report', kind: 'cron', queue: 'schedule' },
    });

    // One run, one trace: the run's own job entry and the exception have to be
    // the same story in the dashboard, not two unrelated rows.
    const runEntry = entries.find(
      (entry) => entry.type === 'job' && entry.batchId === exception?.batchId,
    );
    expect(runEntry).toBeDefined();
    expect(exception?.traceId).not.toBeNull();
    expect(runEntry?.traceId).toBe(exception?.traceId);
  }, 30_000);

  it('applies the shared 4xx skip end-to-end', async () => {
    await expect(task.sync()).rejects.toThrow('nothing to sync');
    await telescope?.flush();

    const entries = (await storage.get({})).data;
    // The failed run is still recorded; only the exception family is skipped.
    expect(entries.some((entry) => entry.familyHash === 'schedule:sync-missing')).toBe(true);
    expect(
      entries.filter(
        (entry) =>
          entry.type === 'exception' &&
          entry.content !== null &&
          `${JSON.stringify(entry.content)}`.includes('nothing to sync'),
      ),
    ).toHaveLength(0);
  }, 30_000);
});
