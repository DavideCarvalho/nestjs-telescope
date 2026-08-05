// packages/schedule/src/schedule.watcher.spec.ts
//
// Unit-level tests drive the SEAM, not the decorated method: they build the
// function `ScheduleExplorer` would build (`instrumentScheduledMethod`, which is
// what the patched `wrapFunctionInTryCatchBlocks` calls) and invoke that. This
// is deliberate — calling `task.run()` directly is exactly the shortcut that let
// a totally dead instrumentation strategy keep a green suite.
//
// The wrap always happens BEFORE `register()` here, mirroring the real
// lifecycle: the explorer wraps at its `onModuleInit`, Telescope binds its
// context at `onApplicationBootstrap`.
//
import 'reflect-metadata';
import {
  type BatchHandle,
  type BatchOrigin,
  type RecordInput,
  type WatcherContext,
  captureException,
  resolveConfig,
} from '@dudousxd/nestjs-telescope';
import { NotFoundException } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { Cron, Interval, SchedulerRegistry } from '@nestjs/schedule';
import { describe, expect, it } from 'vitest';
import {
  type ScheduledFn,
  installExplorerInstrumentation,
  instrumentScheduledMethod,
} from './explorer-instrumentation.js';
import { ScheduleWatcher } from './schedule.watcher.js';

interface RecordedEntry extends RecordInput {
  batch: string | null;
}

interface Harness {
  ctx: WatcherContext;
  recorded: RecordedEntry[];
  origins: BatchOrigin[];
  /** Build the function the explorer would hand the scheduler for `method`, and
   *  return a caller that invokes it on `instance` the way the framework's own
   *  try/catch wrapper does (`methodRef.call(instance, …)`). */
  schedule(instance: object, method: ScheduledFn): () => Promise<unknown>;
}

/** Structural stand-in for ModuleRef — the watcher only ever calls `get`. */
function asModuleRef(source: { get(token: unknown): unknown }): ModuleRef {
  const candidate: unknown = source;
  if (isModuleRef(candidate)) return candidate;
  throw new Error('unreachable: the stand-in exposes get()');
}

function isModuleRef(value: unknown): value is ModuleRef {
  if (typeof value !== 'object' || value === null) return false;
  return typeof Reflect.get(value, 'get') === 'function';
}

function makeHarness(options: { recordThrows?: boolean; registry?: unknown } = {}): Harness {
  const recorded: RecordedEntry[] = [];
  const origins: BatchOrigin[] = [];
  let batchSeq = 0;
  let currentBatch: string | null = null;

  // Stands in for the app's ScheduleExplorer instance: the watcher recognises it
  // by the patched wrapper factory, and the per-app state hangs off it.
  const { wrapFunction } = installExplorerInstrumentation();
  const explorer = { wrapFunctionInTryCatchBlocks: wrapFunction };

  const ctx: WatcherContext = {
    record: (input) => {
      if (options.recordThrows) throw new Error('recorder boom');
      recorded.push({ ...input, batch: currentBatch });
    },
    // The REAL capture (family hash + 4xx policy), so these tests assert on the
    // entry production would store, not on a stand-in of it.
    recordException: (error, details) => {
      if (options.recordThrows) throw new Error('recorder boom');
      captureException(
        (input) => recorded.push({ ...input, batch: currentBatch }),
        error,
        undefined,
        details,
      );
    },
    runInBatch: async <T>(origin: BatchOrigin, fn: () => Promise<T>): Promise<T> => {
      origins.push(origin);
      const previous = currentBatch;
      currentBatch = `batch-${batchSeq++}`;
      try {
        return await fn();
      } finally {
        currentBatch = previous;
      }
    },
    beginBatch: (): BatchHandle => ({ id: 'batch', end: () => {} }),
    config: resolveConfig({}),
    moduleRef: asModuleRef({
      get: (token: unknown) => (token === SchedulerRegistry ? options.registry : explorer),
    }),
  };

  return {
    ctx,
    recorded,
    origins,
    schedule: (instance, method) => {
      const scheduled = instrumentScheduledMethod(explorer, method);
      return () => Promise.resolve(scheduled.call(instance));
    },
  };
}

describe('ScheduleWatcher', () => {
  it('has string type "schedule"', () => {
    expect(new ScheduleWatcher().type).toBe('schedule');
  });

  it('wraps a @Cron method, opens a schedule batch, and records a completed job', async () => {
    class CronTasks {
      public calls = 0;
      @Cron('*/5 * * * * *', { name: 'heartbeat' })
      async beat(): Promise<string> {
        this.calls++;
        return 'beat';
      }
    }
    const tasks = new CronTasks();
    const harness = makeHarness();
    const run = harness.schedule(tasks, CronTasks.prototype.beat);
    new ScheduleWatcher().register(harness.ctx);

    const result = await run();

    expect(result).toBe('beat'); // original behavior preserved
    expect(tasks.calls).toBe(1); // original actually ran
    expect(harness.origins).toEqual(['schedule']); // ran inside a 'schedule' batch
    const jobEntry = harness.recorded.find((e) => e.type === 'job');
    expect(jobEntry).toBeDefined();
    expect(jobEntry!.content).toMatchObject({
      name: 'heartbeat',
      queue: 'schedule',
      status: 'completed',
    });
    expect(jobEntry!.tags).toContain('schedule');
    expect(jobEntry!.tags).toContain('schedule:cron');
    expect(jobEntry!.tags).toContain('task:heartbeat');
    expect(jobEntry!.batch).not.toBeNull();
  });

  it('reports the wraps that happened before register() — the ordering proof', () => {
    class CronTasks {
      @Cron('*/5 * * * * *', { name: 'ordered' })
      async beat(): Promise<string> {
        return 'beat';
      }
    }
    const harness = makeHarness();
    // The explorer wraps at ITS onModuleInit, i.e. before Telescope registers.
    harness.schedule(new CronTasks(), CronTasks.prototype.beat);
    const watcher = new ScheduleWatcher();
    watcher.register(harness.ctx);

    expect(watcher.instrumentedBeforeRegister).toBe(1);
  });

  it('wraps a @Interval method, defaulting the name to the method name', async () => {
    class IntervalTasks {
      @Interval(1000)
      async poll(): Promise<string> {
        return 'poll';
      }
    }
    const harness = makeHarness();
    const run = harness.schedule(new IntervalTasks(), IntervalTasks.prototype.poll);
    new ScheduleWatcher().register(harness.ctx);

    await run();

    expect(harness.origins).toEqual(['schedule']);
    const jobEntry = harness.recorded.find((e) => e.type === 'job');
    expect(jobEntry!.content).toMatchObject({ name: 'poll', status: 'completed' });
    expect(jobEntry!.tags).toContain('schedule:interval');
  });

  it('records a failed run and re-throws so @nestjs/schedule still sees the error', async () => {
    class BoomTask {
      @Cron('* * * * * *', { name: 'explode' })
      async explode(): Promise<never> {
        throw new Error('cron boom');
      }
    }
    const harness = makeHarness();
    const run = harness.schedule(new BoomTask(), BoomTask.prototype.explode);
    new ScheduleWatcher().register(harness.ctx);

    await expect(run()).rejects.toThrow('cron boom');

    const jobEntry = harness.recorded.find((e) => e.type === 'job');
    expect(jobEntry!.content).toMatchObject({ status: 'failed', failureReason: 'cron boom' });
    expect(jobEntry!.tags).toContain('failed');
  });

  it('records an exception entry for a failed run, in the run’s own batch', async () => {
    class ExplodingTask {
      @Cron('* * * * * *', { name: 'nightly-report' })
      async run(): Promise<never> {
        throw new TypeError('report generator blew up');
      }
    }
    const harness = makeHarness();
    const run = harness.schedule(new ExplodingTask(), ExplodingTask.prototype.run);
    new ScheduleWatcher().register(harness.ctx);

    await expect(run()).rejects.toThrow('report generator blew up');

    const jobEntry = harness.recorded.find((e) => e.type === 'job');
    const exception = harness.recorded.find((e) => e.type === 'exception');
    expect(exception).toBeDefined();
    // A cron that has been throwing all week used to be visible only as a
    // failureReason string on its own run entry — no family, no alert, no
    // diagnosis. This is the entry that changes that.
    expect(exception!.familyHash).toMatch(/^TypeError:report generator blew up:at /);
    expect((exception!.content as { context: Record<string, unknown> }).context).toEqual({
      task: 'nightly-report',
      kind: 'cron',
      queue: 'schedule',
    });
    expect(exception!.tags).toEqual(['schedule', 'schedule:cron', 'task:nightly-report']);
    // One run, one batch — the exception and the run entry are the same story.
    expect(exception!.batch).toBe(jobEntry!.batch);
    expect(exception!.batch).not.toBeNull();
  });

  // A scheduled task calling a service that throws NotFoundException is the same
  // expected control flow it is on a route; a cron firing every minute must not
  // be able to open a family (and page) through the back door.
  it('applies the shared 4xx skip: a NotFoundException from a task records no exception', async () => {
    class MissingTask {
      @Cron('* * * * * *', { name: 'sync-missing' })
      async run(): Promise<never> {
        throw new NotFoundException('nothing to sync');
      }
    }
    const harness = makeHarness();
    const run = harness.schedule(new MissingTask(), MissingTask.prototype.run);
    new ScheduleWatcher().register(harness.ctx);

    await expect(run()).rejects.toThrow('nothing to sync');

    expect(harness.recorded.filter((e) => e.type === 'exception')).toHaveLength(0);
    expect(harness.recorded.filter((e) => e.type === 'job')).toHaveLength(1);
  });

  it('records no exception entry for a run that succeeds', async () => {
    class QuietTask {
      @Cron('* * * * * *', { name: 'quiet' })
      async run(): Promise<string> {
        return 'ok';
      }
    }
    const harness = makeHarness();
    const run = harness.schedule(new QuietTask(), QuietTask.prototype.run);
    new ScheduleWatcher().register(harness.ctx);

    await run();

    expect(harness.recorded.filter((e) => e.type === 'exception')).toHaveLength(0);
  });

  it('tags slow runs whose duration meets slowMs', async () => {
    class SlowTask {
      @Cron('* * * * * *', { name: 'slow' })
      async run(): Promise<string> {
        return 'ok';
      }
    }
    let t = 0;
    const clock = {
      now: () => {
        const value = t;
        t += 150;
        return value;
      },
    };
    const harness = makeHarness();
    const run = harness.schedule(new SlowTask(), SlowTask.prototype.run);
    new ScheduleWatcher({ slowMs: 100, clock }).register(harness.ctx);

    await run();

    const jobEntry = harness.recorded.find((e) => e.type === 'job');
    expect(jobEntry!.durationMs).toBe(150);
    expect(jobEntry!.tags).toContain('slow');
  });

  it('correlates work emitted during the task to the same schedule batch', async () => {
    class Correlating {
      constructor(private readonly ctx: WatcherContext) {}
      @Cron('* * * * * *', { name: 'corr' })
      async run(): Promise<string> {
        this.ctx.record({ type: 'query', content: { sql: 'select 1' } });
        return 'ok';
      }
    }
    const harness = makeHarness();
    const instance = new Correlating(harness.ctx);
    const run = harness.schedule(instance, Correlating.prototype.run);
    new ScheduleWatcher().register(harness.ctx);

    await run();

    const query = harness.recorded.find((e) => e.type === 'query');
    const job = harness.recorded.find((e) => e.type === 'job');
    expect(query!.batch).toBe(job!.batch);
  });

  it('never corrupts the run outcome when ctx.record throws', async () => {
    class OkTask {
      @Cron('* * * * * *', { name: 'ok' })
      async run(): Promise<string> {
        return 'ok';
      }
    }
    class BoomTask {
      @Cron('* * * * * *', { name: 'boom' })
      async run(): Promise<never> {
        throw new Error('cron boom');
      }
    }
    const okHarness = makeHarness({ recordThrows: true });
    const runOk = okHarness.schedule(new OkTask(), OkTask.prototype.run);
    new ScheduleWatcher().register(okHarness.ctx);
    await expect(runOk()).resolves.toBe('ok');

    const boomHarness = makeHarness({ recordThrows: true });
    const runBoom = boomHarness.schedule(new BoomTask(), BoomTask.prototype.run);
    new ScheduleWatcher().register(boomHarness.ctx);
    await expect(runBoom()).rejects.toThrow('cron boom');
  });

  it('calls the handler straight through before register() has bound a context', async () => {
    class EarlyTask {
      public calls = 0;
      @Cron('* * * * * *', { name: 'early' })
      async run(): Promise<string> {
        this.calls++;
        return 'ok';
      }
    }
    const task = new EarlyTask();
    const harness = makeHarness();
    const run = harness.schedule(task, EarlyTask.prototype.run);

    // A tick between the explorer's onModuleInit and Telescope's registration:
    // untraced, but it must still run and still return normally.
    await expect(run()).resolves.toBe('ok');
    expect(task.calls).toBe(1);
    expect(harness.recorded).toHaveLength(0);
  });

  it('warns and no-ops cleanly when the explorer wrapped nothing', () => {
    const harness = makeHarness();
    expect(() => new ScheduleWatcher().register(harness.ctx)).not.toThrow();
    expect(harness.recorded).toHaveLength(0);
  });
});

// A fake SchedulerRegistry exposing a cron + an interval (structurally typed).
function fakeRegistry(
  next: Date,
  running = true,
): {
  getCronJobs: () => Map<
    string,
    { cronTime: { source: string }; nextDate: () => Date; running: boolean }
  >;
  getIntervals: () => string[];
  getTimeouts: () => string[];
} {
  return {
    getCronJobs: () =>
      new Map([['nightly', { cronTime: { source: '0 0 * * *' }, nextDate: () => next, running }]]),
    getIntervals: () => ['heartbeat'],
    getTimeouts: () => [],
  };
}

describe('ScheduleWatcher.listTasks (ScheduleManager)', () => {
  it('lists cron + interval tasks with schedule and next-run from the registry', async () => {
    const next = new Date('2026-06-04T00:00:00.000Z');
    const harness = makeHarness({ registry: fakeRegistry(next) });
    const watcher = new ScheduleWatcher();
    watcher.register(harness.ctx);

    const tasks = await watcher.listTasks();

    const cron = tasks.find((t) => t.name === 'nightly');
    expect(cron).toMatchObject({
      kind: 'cron',
      schedule: '0 0 * * *',
      nextRunAt: next.toISOString(),
      running: true,
    });
    const interval = tasks.find((t) => t.name === 'heartbeat');
    // Intervals expose no running state through SchedulerRegistry → null, not a guess.
    expect(interval).toMatchObject({ kind: 'interval', nextRunAt: null, running: null });
  });

  it('reports a stopped cron as running:false (registered but will not fire)', async () => {
    const next = new Date('2026-06-04T00:00:00.000Z');
    const harness = makeHarness({ registry: fakeRegistry(next, false) });
    const watcher = new ScheduleWatcher();
    watcher.register(harness.ctx);

    const cron = (await watcher.listTasks()).find((t) => t.name === 'nightly');
    expect(cron?.running).toBe(false);
  });

  it('merges last-run info recorded by a real run', async () => {
    const next = new Date('2026-06-04T00:00:00.000Z');
    let nowMs = 1_000;
    class CronTasks {
      @Cron('0 0 * * *', { name: 'nightly' })
      async run(): Promise<string> {
        return 'ok';
      }
    }
    const harness = makeHarness({ registry: fakeRegistry(next) });
    const run = harness.schedule(new CronTasks(), CronTasks.prototype.run);
    const watcher = new ScheduleWatcher({ clock: { now: () => nowMs } });
    watcher.register(harness.ctx);

    nowMs = 5_000; // run finishes "later" so a duration is recorded
    await run();

    const listed = await watcher.listTasks();
    const cron = listed.find((t) => t.name === 'nightly');
    expect(cron?.lastStatus).toBe('completed');
    expect(cron?.lastRunAt).toBe(new Date(5_000).toISOString());
    expect(typeof cron?.lastDurationMs).toBe('number');
  });

  it('degrades gracefully when registry methods are missing', async () => {
    const harness = makeHarness({ registry: {} });
    const watcher = new ScheduleWatcher();
    watcher.register(harness.ctx);
    await expect(watcher.listTasks()).resolves.toEqual([]);
  });

  it('returns an empty list when no registry is resolvable', async () => {
    const harness = makeHarness();
    const watcher = new ScheduleWatcher();
    watcher.register(harness.ctx);
    await expect(watcher.listTasks()).resolves.toEqual([]);
  });
});
