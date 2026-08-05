// packages/schedule/src/schedule.watcher.integration.spec.ts
//
// End-to-end against a REAL app driven by the REAL trigger: a real
// `TelescopeModule` graph (real Recorder, real storage, real trace-context
// provider, real watcher registration through TelescopeWatcherRegistrar), a real
// `ScheduleModule`, and `@Cron`/`@Interval` tasks that `@nestjs/schedule` fires
// on its own timers. Nothing is invoked by hand.
//
// WHY that matters more than it sounds: the previous version of this file
// invoked `task.run()` directly and passed, while a timer-driven run recorded
// NOTHING — no entry, no exception, not even a batch. The watcher patched the
// provider's prototype at `onApplicationBootstrap`, long after
// `ScheduleExplorer` had already closed over `instance[key]` at its own
// `onModuleInit`. A test that calls the method itself cannot see that gap, which
// is precisely why the gap survived. Every assertion below waits for the
// scheduler to fire.
//
// Note: Vitest uses esbuild, which does NOT emit decorator metadata, so the task
// providers rely only on the decorators' own explicit metadata and have no
// injected constructor deps.
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
import { Injectable, Module, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression, Interval, SchedulerRegistry } from '@nestjs/schedule';
import { ScheduleModule } from '@nestjs/schedule';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScheduleWatcher } from './schedule.watcher.js';

const storage = new InMemoryStorageProvider();
const watcher = new ScheduleWatcher({ slowMs: 999_999 });

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
class TimerTasks {
  /** Proof the task still FIRES: a wrapper that dropped the SCHEDULER_* metadata
   *  would leave this at 0 forever — a broken cron, not just a blind one. */
  public heartbeats = 0;
  public polls = 0;

  @Cron(CronExpression.EVERY_SECOND, { name: 'heartbeat' })
  beat(): void {
    this.heartbeats++;
  }

  @Cron(CronExpression.EVERY_SECOND, { name: 'nightly-report' })
  report(): never {
    throw new TypeError('report generator blew up');
  }

  @Cron(CronExpression.EVERY_SECOND, { name: 'sync-missing' })
  sync(): never {
    throw new NotFoundException('nothing to sync');
  }

  @Interval('poll', 300)
  poll(): void {
    this.polls++;
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
    ScheduleModule.forRoot(),
  ],
  providers: [TimerTasks],
})
class AppModule {}

/** Poll up to ~15s for entries the scheduler produces on its own. */
async function waitForEntries(predicate: (entries: Entry[]) => boolean): Promise<Entry[]> {
  for (let i = 0; i < 150; i++) {
    await telescope?.flush();
    const entries = (await storage.get({})).data;
    if (predicate(entries)) return entries;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await telescope?.flush();
  return (await storage.get({})).data;
}

function jobEntries(entries: Entry[], name: string): Entry[] {
  return entries.filter(
    (entry) =>
      entry.type === 'job' &&
      typeof entry.content === 'object' &&
      entry.content !== null &&
      Reflect.get(entry.content, 'name') === name,
  );
}

describe('ScheduleWatcher end-to-end (real ScheduleModule, timer-driven)', () => {
  let app: TestingModule;
  let tasks: TimerTasks;

  beforeAll(async () => {
    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    telescope = app.get(TelescopeService);
    tasks = app.get(TimerTasks);
    await app.init();
    // Every assertion below reads from this one window of real ticks.
    await waitForEntries(
      (entries) =>
        jobEntries(entries, 'heartbeat').length > 0 &&
        jobEntries(entries, 'poll').length > 0 &&
        entries.some((entry) => entry.type === 'exception'),
    );
  }, 40_000);

  afterAll(async () => {
    await app?.close();
  });

  it('instruments before @nestjs/schedule captures its handlers', () => {
    // The explorer wraps at ITS onModuleInit; Telescope binds at
    // onApplicationBootstrap. A non-zero count can only happen if the seam was
    // already installed when the explorer ran — which is the whole fix. Going
    // back to patching prototypes at registration drives this to zero.
    expect(watcher.instrumentedBeforeRegister).toBe(4);
  });

  it('keeps the tasks scheduled and firing (metadata survived the wrapper)', () => {
    expect(tasks.heartbeats).toBeGreaterThan(0);
    expect(tasks.polls).toBeGreaterThan(0);
    const cronNames = Array.from(app.get(SchedulerRegistry).getCronJobs().keys());
    expect(cronNames).toEqual(expect.arrayContaining(['heartbeat', 'nightly-report']));
    expect(app.get(SchedulerRegistry).getIntervals()).toContain('poll');
  });

  it('records a timer-driven @Cron tick with its own schedule batch and trace', async () => {
    const entries = await waitForEntries((all) => jobEntries(all, 'heartbeat').length > 0);
    const heartbeat = jobEntries(entries, 'heartbeat')[0];

    expect(heartbeat).toBeDefined();
    expect(heartbeat?.origin).toBe('schedule');
    expect(heartbeat?.traceId).not.toBeNull();
    expect(heartbeat?.content).toMatchObject({
      name: 'heartbeat',
      queue: 'schedule',
      status: 'completed',
    });
    expect(heartbeat?.tags).toEqual(expect.arrayContaining(['schedule', 'schedule:cron']));
  }, 40_000);

  it('records a timer-driven @Interval tick', async () => {
    const entries = await waitForEntries((all) => jobEntries(all, 'poll').length > 0);
    const poll = jobEntries(entries, 'poll')[0];

    expect(poll).toBeDefined();
    expect(poll?.origin).toBe('schedule');
    expect(poll?.tags).toContain('schedule:interval');
  }, 40_000);

  it('turns a timer-driven throw into an exception entry sharing the run’s trace', async () => {
    const entries = await waitForEntries((all) => all.some((e) => e.type === 'exception'));
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
  }, 40_000);

  it('applies the shared 4xx skip end-to-end', async () => {
    const entries = await waitForEntries((all) => jobEntries(all, 'sync-missing').length > 0);

    // The failed run is still recorded; only the exception family is skipped.
    expect(jobEntries(entries, 'sync-missing').length).toBeGreaterThan(0);
    expect(
      entries.filter(
        (entry) =>
          entry.type === 'exception' && JSON.stringify(entry.content).includes('nothing to sync'),
      ),
    ).toHaveLength(0);
  }, 40_000);
});
