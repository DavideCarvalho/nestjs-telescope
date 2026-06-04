// packages/schedule/src/schedule.watcher.spec.ts
import 'reflect-metadata';
import {
  type BatchHandle,
  type BatchOrigin,
  type RecordInput,
  type WatcherContext,
  resolveConfig,
} from '@dudousxd/nestjs-telescope';
import type { DiscoveryService, ModuleRef } from '@nestjs/core';
import { Cron, Interval, SchedulerRegistry } from '@nestjs/schedule';
import { describe, expect, it } from 'vitest';
import { ScheduleWatcher } from './schedule.watcher.js';

// Each test defines its own task class so the prototype it patches is pristine
// (the watcher patches prototypes once, guarded by a module-global marker —
// sharing a class across tests would leak the first test's wrapper/ctx).

interface RecordedEntry extends RecordInput {
  batch: string | null;
}

interface Harness {
  ctx: WatcherContext;
  recorded: RecordedEntry[];
  origins: BatchOrigin[];
}

function makeHarness(
  providers: Array<{ instance: unknown }>,
  options: { recordThrows?: boolean; registry?: unknown } = {},
): Harness {
  const recorded: RecordedEntry[] = [];
  const origins: BatchOrigin[] = [];
  let batchSeq = 0;
  let currentBatch: string | null = null;
  const discovery = { getProviders: () => providers } as unknown as DiscoveryService;
  const moduleRef = {
    get: (token: unknown) => (token === SchedulerRegistry ? options.registry : discovery),
  } as unknown as ModuleRef;

  const ctx: WatcherContext = {
    record: (input) => {
      if (options.recordThrows) throw new Error('recorder boom');
      recorded.push({ ...input, batch: currentBatch });
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
    moduleRef,
  };
  return { ctx, recorded, origins };
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
    const { ctx, recorded, origins } = makeHarness([{ instance: tasks }]);
    new ScheduleWatcher().register(ctx);

    const result = await tasks.beat();

    expect(result).toBe('beat'); // original behavior preserved
    expect(tasks.calls).toBe(1); // original actually ran
    expect(origins).toEqual(['schedule']); // ran inside a 'schedule' batch
    const jobEntry = recorded.find((e) => e.type === 'job');
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

  it('wraps a @Interval method, defaulting the name to the method name', async () => {
    class IntervalTasks {
      @Interval(1000)
      async poll(): Promise<string> {
        return 'poll';
      }
    }
    const tasks = new IntervalTasks();
    const { ctx, recorded, origins } = makeHarness([{ instance: tasks }]);
    new ScheduleWatcher().register(ctx);

    await tasks.poll();

    expect(origins).toEqual(['schedule']);
    const jobEntry = recorded.find((e) => e.type === 'job');
    expect(jobEntry!.content).toMatchObject({ name: 'poll', status: 'completed' });
    expect(jobEntry!.tags).toContain('schedule:interval');
  });

  it('leaves non-scheduled methods alone', async () => {
    class MixedTasks {
      @Cron('* * * * * *', { name: 'c' })
      async scheduled(): Promise<string> {
        return 's';
      }
      async plain(): Promise<string> {
        return 'plain';
      }
    }
    const tasks = new MixedTasks();
    const { ctx, recorded, origins } = makeHarness([{ instance: tasks }]);
    new ScheduleWatcher().register(ctx);

    const result = await tasks.plain();

    expect(result).toBe('plain');
    expect(origins).toEqual([]); // no batch opened for the plain method
    expect(recorded).toHaveLength(0);
  });

  it('records a failed run and re-throws so @nestjs/schedule still sees the error', async () => {
    class BoomTask {
      @Cron('* * * * * *', { name: 'explode' })
      async explode(): Promise<never> {
        throw new Error('cron boom');
      }
    }
    const task = new BoomTask();
    const { ctx, recorded } = makeHarness([{ instance: task }]);
    new ScheduleWatcher().register(ctx);

    await expect(task.explode()).rejects.toThrow('cron boom');

    const jobEntry = recorded.find((e) => e.type === 'job');
    expect(jobEntry!.content).toMatchObject({ status: 'failed', failureReason: 'cron boom' });
    expect(jobEntry!.tags).toContain('failed');
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
    const provider = { instance: undefined as unknown };
    const { ctx, recorded } = makeHarness([provider]);
    const instance = new Correlating(ctx);
    provider.instance = instance;
    new ScheduleWatcher().register(ctx);

    await instance.run();

    const query = recorded.find((e) => e.type === 'query');
    const job = recorded.find((e) => e.type === 'job');
    expect(query!.batch).toBe(job!.batch);
  });

  it('patches a shared prototype only once across instances', async () => {
    class SharedTasks {
      @Cron('* * * * * *', { name: 'shared' })
      async beat(): Promise<string> {
        return 'beat';
      }
    }
    const a = new SharedTasks();
    const b = new SharedTasks();
    const { ctx, recorded } = makeHarness([{ instance: a }, { instance: b }]);
    new ScheduleWatcher().register(ctx);

    await a.beat();

    expect(recorded.filter((e) => e.type === 'job')).toHaveLength(1);
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
    const ok = new OkTask();
    const okHarness = makeHarness([{ instance: ok }], { recordThrows: true });
    new ScheduleWatcher().register(okHarness.ctx);
    await expect(ok.run()).resolves.toBe('ok');

    const boom = new BoomTask();
    const boomHarness = makeHarness([{ instance: boom }], { recordThrows: true });
    new ScheduleWatcher().register(boomHarness.ctx);
    await expect(boom.run()).rejects.toThrow('cron boom');
  });

  it('warns and no-ops cleanly when no scheduled methods are present', () => {
    class NoSchedule {
      async work(): Promise<void> {}
    }
    const { ctx, recorded } = makeHarness([{ instance: new NoSchedule() }]);
    expect(() => new ScheduleWatcher().register(ctx)).not.toThrow();
    expect(recorded).toHaveLength(0);
  });
});

// A fake SchedulerRegistry exposing a cron + an interval (structurally typed).
function fakeRegistry(next: Date): {
  getCronJobs: () => Map<string, { cronTime: { source: string }; nextDate: () => Date }>;
  getIntervals: () => string[];
  getTimeouts: () => string[];
} {
  return {
    getCronJobs: () =>
      new Map([['nightly', { cronTime: { source: '0 0 * * *' }, nextDate: () => next }]]),
    getIntervals: () => ['heartbeat'],
    getTimeouts: () => [],
  };
}

describe('ScheduleWatcher.listTasks (ScheduleManager)', () => {
  it('lists cron + interval tasks with schedule and next-run from the registry', async () => {
    const next = new Date('2026-06-04T00:00:00.000Z');
    class CronTasks {
      @Cron('0 0 * * *', { name: 'nightly' })
      async run(): Promise<void> {}
    }
    const { ctx } = makeHarness([{ instance: new CronTasks() }], { registry: fakeRegistry(next) });
    const watcher = new ScheduleWatcher();
    watcher.register(ctx);

    const tasks = await watcher.listTasks();

    const cron = tasks.find((t) => t.name === 'nightly');
    expect(cron).toMatchObject({
      kind: 'cron',
      schedule: '0 0 * * *',
      nextRunAt: next.toISOString(),
    });
    const interval = tasks.find((t) => t.name === 'heartbeat');
    expect(interval).toMatchObject({ kind: 'interval', nextRunAt: null });
  });

  it('merges last-run info recorded by a simulated run', async () => {
    const next = new Date('2026-06-04T00:00:00.000Z');
    let nowMs = 1_000;
    class CronTasks {
      @Cron('0 0 * * *', { name: 'nightly' })
      async run(): Promise<string> {
        return 'ok';
      }
    }
    const tasks = new CronTasks();
    const { ctx } = makeHarness([{ instance: tasks }], { registry: fakeRegistry(next) });
    const watcher = new ScheduleWatcher({ clock: { now: () => nowMs } });
    watcher.register(ctx);

    nowMs = 5_000; // run finishes "later" so a duration is recorded
    await tasks.run();

    const listed = await watcher.listTasks();
    const cron = listed.find((t) => t.name === 'nightly');
    expect(cron?.lastStatus).toBe('completed');
    expect(cron?.lastRunAt).toBe(new Date(5_000).toISOString());
    expect(typeof cron?.lastDurationMs).toBe('number');
  });

  it('degrades gracefully when registry methods are missing', async () => {
    const { ctx } = makeHarness([], { registry: {} });
    const watcher = new ScheduleWatcher();
    watcher.register(ctx);
    await expect(watcher.listTasks()).resolves.toEqual([]);
  });

  it('returns an empty list when no registry is resolvable', async () => {
    const { ctx } = makeHarness([]);
    const watcher = new ScheduleWatcher();
    watcher.register(ctx);
    await expect(watcher.listTasks()).resolves.toEqual([]);
  });
});
