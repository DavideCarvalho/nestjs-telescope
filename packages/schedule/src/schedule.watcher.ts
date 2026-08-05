// packages/schedule/src/schedule.watcher.ts
import 'reflect-metadata';
import {
  EntryType,
  type RecordInput,
  type ScheduleKind,
  type ScheduleManager,
  type ScheduleManagerContext,
  type ScheduleRunStatus,
  type ScheduledTask,
  type Watcher,
  type WatcherContext,
  isScheduleKind,
} from '@dudousxd/nestjs-telescope';
import { Logger } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  type ExplorerInstrumentation,
  type ScheduleRunner,
  type ScheduledFn,
  bindScheduleRunner,
  installExplorerInstrumentation,
} from './explorer-instrumentation.js';

/** The `@nestjs/schedule` metadata keys its decorators set on each handler.
 *  Read from the installed package's `schedule.constants` (v4); a method
 *  decorated by `@Cron`/`@Interval`/`@Timeout` carries one of the *_OPTIONS
 *  keys plus `SCHEDULER_TYPE`/`SCHEDULER_NAME`. */
const SCHEDULER_TYPE = 'SCHEDULER_TYPE';
const SCHEDULER_NAME = 'SCHEDULER_NAME';
const SCHEDULE_CRON_OPTIONS = 'SCHEDULE_CRON_OPTIONS';
const SCHEDULE_INTERVAL_OPTIONS = 'SCHEDULE_INTERVAL_OPTIONS';
const SCHEDULE_TIMEOUT_OPTIONS = 'SCHEDULE_TIMEOUT_OPTIONS';

/** `SchedulerType` enum values (CRON=1, TIMEOUT=2, INTERVAL=3) → a label. */
const SCHEDULER_TYPE_LABEL: Record<number, string> = {
  1: 'cron',
  2: 'timeout',
  3: 'interval',
};

/** What we read off a `@nestjs/schedule` CronJob — structural, never the import. */
interface CronJobLike {
  cronTime?: { source?: unknown };
  nextDate?: () => unknown;
  /** The `cron` package's started/stopped flag; absent on older versions. */
  running?: unknown;
  /** Some `cron` versions expose `isActive` instead of/alongside `running`. */
  isActive?: unknown;
}
/** Structural view of `SchedulerRegistry` (resolved via moduleRef). All methods
 *  optional so a missing/partial registry degrades gracefully (never throws). */
interface SchedulerRegistryLike {
  getCronJobs?: () => Map<string, CronJobLike> | undefined;
  getIntervals?: () => string[] | undefined;
  getTimeouts?: () => string[] | undefined;
}

/** Last observed run for a task, by name — fed by the watcher's record path. */
interface LastRun {
  at: string;
  durationMs: number;
  status: ScheduleRunStatus;
}

/** Coerce CronJob.cronTime.source (string or a CronTime-ish object) to a string. */
function cronSource(job: CronJobLike): string {
  const source = job.cronTime?.source;
  if (typeof source === 'string') return source;
  if (source != null) return String(source);
  return '';
}

/** Narrow an unknown to something exposing a luxon-style `toJSDate()`. */
function hasToJsDate(value: unknown): value is { toJSDate: () => unknown } {
  if (typeof value !== 'object' || value === null || !('toJSDate' in value)) return false;
  return typeof Reflect.get(value, 'toJSDate') === 'function';
}

/**
 * Read a CronJob's active (started) state. The `cron` package exposes this as the
 * boolean `running` (newer builds also `isActive`). Returns `null` when neither is
 * a boolean, so the console renders "unknown" rather than guessing a state.
 */
function cronRunning(job: CronJobLike): boolean | null {
  if (typeof job.running === 'boolean') return job.running;
  if (typeof job.isActive === 'boolean') return job.isActive;
  return null;
}

/** Read a CronJob's next fire time as an ISO string, or null if unavailable. */
function cronNextRunAt(job: CronJobLike): string | null {
  if (typeof job.nextDate !== 'function') return null;
  try {
    const next = job.nextDate();
    if (next == null) return null;
    // `@nestjs/schedule`'s CronJob.nextDate() returns a luxon DateTime
    // (exposes toJSDate()); a plain Date is used directly.
    const date = hasToJsDate(next) ? next.toJSDate() : next;
    if (date instanceof Date && !Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
    return null;
  } catch {
    return null;
  }
}

export interface ScheduleWatcherOptions {
  /** Runs whose duration is >= this (ms) get a 'slow' tag. Default 1000. */
  slowMs?: number;
  /** Time source; injectable for tests. Default wall clock. */
  clock?: { now(): number };
}

/** Reflect.getMetadata, defensively (target may be a non-decorable value). */
function readMetadata(key: string, target: unknown): unknown {
  if (typeof target === 'function' || (typeof target === 'object' && target !== null)) {
    return Reflect.getMetadata(key, target);
  }
  return undefined;
}

/** Is this method decorated by a `@nestjs/schedule` decorator? Returns the
 *  scheduler-type label (cron/interval/timeout) or null. */
function schedulerLabel(methodRef: unknown): string | null {
  if (typeof methodRef !== 'function') return null;
  const typeValue = readMetadata(SCHEDULER_TYPE, methodRef);
  if (typeof typeValue === 'number' && SCHEDULER_TYPE_LABEL[typeValue]) {
    return SCHEDULER_TYPE_LABEL[typeValue] ?? null;
  }
  // Fallback: presence of any options key still identifies a scheduled method.
  if (readMetadata(SCHEDULE_CRON_OPTIONS, methodRef) !== undefined) return 'cron';
  if (readMetadata(SCHEDULE_INTERVAL_OPTIONS, methodRef) !== undefined) return 'interval';
  if (readMetadata(SCHEDULE_TIMEOUT_OPTIONS, methodRef) !== undefined) return 'timeout';
  return null;
}

/**
 * Captures `@nestjs/schedule` cron/interval/timeout runs, opening a `'schedule'`
 * batch per run so each scheduled task's queries/exceptions correlate to it, and
 * records a job-type entry for the run itself.
 *
 * ## How it works
 * The watcher's CONSTRUCTOR patches
 * `ScheduleExplorer.prototype.wrapFunctionInTryCatchBlocks` — the last point at
 * which the framework still holds the RAW handler — so every function the
 * explorer hands to the scheduler is already a Telescope wrapper. See
 * `explorer-instrumentation.ts` for why that seam and not the provider's
 * prototype: the explorer reads `instance[key]` once at its own `onModuleInit`,
 * so a prototype patch applied at `onApplicationBootstrap` is never seen by a
 * timer-driven run. Importing Telescope first does not change that (measured: a
 * `@Cron` firing every second for ten seconds produced zero entries), and
 * neither does moving the registrar to `onModuleInit`.
 *
 * `register()` then points that seam at the live `WatcherContext`. The binding
 * is deliberately late: a tick that fires before Telescope has registered calls
 * the handler straight through rather than waiting on it.
 *
 * Entries are recorded as `EntryType.Job` (a scheduled task *is* a job; the
 * `'schedule'` batch origin distinguishes it from a queue job), while the
 * watcher's own `type` is the string `'schedule'` so it surfaces distinctly in
 * `/meta`.
 *
 * The wrapper never swallows the host's error: on failure it records a `failed`
 * entry and re-throws, so `@nestjs/schedule`'s own try/catch — which sits
 * outside Telescope's wrapper — logs it exactly as it would have.
 *
 * @remarks
 * If the installed `@nestjs/schedule` exposes no such seam, `register()` warns
 * with the version and the fact that scheduled runs are not captured, rather
 * than registering and recording nothing — silence is what let the previous
 * strategy survive.
 */
export class ScheduleWatcher implements Watcher, ScheduleManager {
  /** String `type` (allowed by the SPI) so the watcher shows distinctly in
   *  `/meta`; entries themselves are recorded as `EntryType.Job`. */
  readonly type = 'schedule';
  private readonly logger = new Logger(ScheduleWatcher.name);
  private readonly slowMs: number;
  private readonly clock: { now(): number };
  private readonly instrumentation: ExplorerInstrumentation;
  /** Last observed run per task name, fed by the record path (Schedule console). */
  private readonly lastRuns = new Map<string, LastRun>();
  /** Captured at register() so `listTasks` can resolve `SchedulerRegistry`. */
  private moduleRef: ModuleRef | undefined;
  /**
   * Handlers the seam had already wrapped when `register()` ran. A non-zero
   * count is the machine-checkable proof that instrumentation preceded the
   * framework's explorer; a regression to late patching drives it to zero.
   */
  private wrappedBeforeRegister = 0;

  constructor(options: ScheduleWatcherOptions = {}) {
    this.slowMs = options.slowMs ?? 1000;
    this.clock = options.clock ?? { now: () => Date.now() };
    // Runs while the host is still building its module metadata — before
    // NestFactory.create, therefore before ScheduleExplorer.onModuleInit.
    this.instrumentation = installExplorerInstrumentation();
  }

  /** Scheduled handlers instrumented before `register()` ran. Read by the
   *  ordering regression test, and by nothing else. */
  get instrumentedBeforeRegister(): number {
    return this.wrappedBeforeRegister;
  }

  register(ctx: WatcherContext): void {
    this.moduleRef = ctx.moduleRef;
    const host = this.resolveSeamHost(ctx);
    if (!host) {
      const reason =
        this.instrumentation.reason ??
        'no ScheduleExplorer is present in the module tree (is ScheduleModule.forRoot() imported?)';
      this.logger.warn(`ScheduleWatcher: ${reason}. Scheduled runs will NOT be captured.`);
      return;
    }

    const runner: ScheduleRunner = (methodRef, invoke) => this.runScheduled(ctx, methodRef, invoke);
    this.wrappedBeforeRegister = bindScheduleRunner(host, runner);
    if (this.wrappedBeforeRegister === 0) {
      this.logger.warn(
        'ScheduleWatcher: no @nestjs/schedule (@Cron/@Interval/@Timeout) methods were found by the ' +
          'explorer. Scheduled tasks will not be captured (request-scoped providers are skipped by ' +
          '@nestjs/schedule itself).',
      );
      return;
    }
    this.logger.log(
      `ScheduleWatcher: instrumented ${this.wrappedBeforeRegister} scheduled method(s).`,
    );
  }

  /**
   * The app's `ScheduleExplorer` instance, but only if its wrapper factory is
   * the function this package installed — a host that somehow supplied its own
   * explorer would otherwise be reported as instrumented while recording
   * nothing, which is the failure this watcher is being fixed for.
   */
  private resolveSeamHost(ctx: WatcherContext): object | null {
    const { explorerClass, wrapFunction } = this.instrumentation;
    if (!explorerClass || !wrapFunction) return null;
    try {
      const found: unknown = ctx.moduleRef.get(explorerClass, { strict: false });
      if (typeof found !== 'object' || found === null) return null;
      return Reflect.get(found, 'wrapFunctionInTryCatchBlocks') === wrapFunction ? found : null;
    } catch {
      return null;
    }
  }

  /** Name + kind for a handler, from the decorator metadata `@nestjs/schedule`
   *  itself reads. Falls back to the method name, then to `'unnamed'`. */
  private describe(methodRef: ScheduledFn): { name: string; label: string } {
    try {
      const named = readMetadata(SCHEDULER_NAME, methodRef);
      const name =
        typeof named === 'string' && named.length > 0 ? named : methodRef.name || 'unnamed';
      return { name, label: schedulerLabel(methodRef) ?? 'cron' };
    } catch {
      return { name: 'unnamed', label: 'cron' };
    }
  }

  /** One scheduled run: its own `schedule` batch, its entry, and its throw
   *  re-thrown so `@nestjs/schedule`'s own handler still sees it. */
  private runScheduled(
    ctx: WatcherContext,
    methodRef: ScheduledFn,
    invoke: () => Promise<unknown>,
  ): Promise<unknown> {
    // Reading metadata happens on the host's own thread, before the task runs,
    // so it gets the same guard the record path has: a hostile getter must not
    // be able to stop a cron from firing.
    const { name, label } = this.describe(methodRef);

    return ctx.runInBatch('schedule', async () => {
      const startedAt = this.clock.now();
      try {
        const result = await invoke();
        this.safeRecord(ctx, name, label, 'completed', this.clock.now() - startedAt, undefined);
        return result;
      } catch (error) {
        this.safeRecord(ctx, name, label, 'failed', this.clock.now() - startedAt, error);
        this.safeRecordException(ctx, name, label, error);
        throw error; // never break the scheduled task
      }
    });
  }

  /**
   * Turn a scheduled task's throw into an `exception` entry, in the run's batch.
   *
   * WHY this is not redundant with the `failed` run entry above: that entry
   * carries the failure only as a `failureReason` string, which opens no
   * exception family. A nightly cron that has been throwing for a week would
   * never fire `new-exception`, never get an AI diagnosis, and never appear in
   * the exceptions view — precisely the job you least want to find out about by
   * accident. Routing through `ctx.recordException` gives it the same family
   * hash and the same 4xx policy as a route that throws the same error.
   *
   * Guarded twice over: the `typeof` check keeps the watcher working against a
   * `WatcherContext` from an older core, and the try/catch means recording can
   * never add a second throw on top of the task's own.
   */
  private safeRecordException(
    ctx: WatcherContext,
    name: string,
    label: string,
    error: unknown,
  ): void {
    try {
      if (typeof ctx.recordException !== 'function') return;
      ctx.recordException(error, {
        // No sibling `request` entry exists off the request path, so the
        // exception has to name the task that produced it.
        context: { task: name, kind: label, queue: 'schedule' },
        tags: ['schedule', `schedule:${label}`, `task:${name}`],
      });
    } catch (recordError) {
      const message = recordError instanceof Error ? recordError.message : String(recordError);
      this.logger.error(`ScheduleWatcher: failed to record scheduled exception: ${message}`);
    }
  }

  /** Build + record a job entry for a scheduled run, swallowing any failure so a
   *  telescope error can never break the scheduled task. */
  private safeRecord(
    ctx: WatcherContext,
    name: string,
    label: string,
    status: 'completed' | 'failed',
    durationMs: number,
    error: unknown,
  ): void {
    // Track the last run for the Schedule console (additive to recording).
    this.lastRuns.set(name, {
      at: new Date(this.clock.now()).toISOString(),
      durationMs,
      status,
    });
    try {
      const failureReason =
        status === 'failed' ? (error instanceof Error ? error.message : String(error)) : null;
      const tags = ['schedule', `schedule:${label}`, `task:${name}`];
      if (status === 'failed') tags.push('failed');
      if (durationMs >= this.slowMs) tags.push('slow');

      const input: RecordInput = {
        type: EntryType.Job,
        familyHash: `schedule:${name}`,
        durationMs,
        tags,
        content: {
          id: null,
          name,
          queue: 'schedule',
          payload: null,
          status,
          attempts: 1,
          maxAttempts: null,
          waitMs: null,
          failureReason,
        },
      };
      ctx.record(input);
    } catch (recordError) {
      const message = recordError instanceof Error ? recordError.message : String(recordError);
      this.logger.error(`ScheduleWatcher: failed to record scheduled run: ${message}`);
    }
  }

  /**
   * ScheduleManager: list the registered cron/interval/timeout tasks from
   * `SchedulerRegistry`, merged with the watcher's recorded last-run info.
   * Fully defensive — a missing registry or method yields an empty/degraded
   * list and never throws (this feeds a read-only console).
   *
   * `ctx.moduleRef` is preferred (the registry passes it on the live config);
   * the moduleRef captured at `register()` is the fallback for the watcher path.
   */
  async listTasks(ctx?: ScheduleManagerContext): Promise<ScheduledTask[]> {
    const registry = this.resolveRegistry(ctx?.moduleRef ?? this.moduleRef);
    if (!registry) return [];
    const tasks: ScheduledTask[] = [];

    const cronJobs = this.callSafe(() => registry.getCronJobs?.());
    if (cronJobs && typeof cronJobs.forEach === 'function') {
      for (const [name, job] of cronJobs) {
        tasks.push(
          this.buildTask(name, 'cron', cronSource(job), cronNextRunAt(job), cronRunning(job)),
        );
      }
    }

    // Intervals/timeouts: SchedulerRegistry exposes only their names, so neither a
    // next-fire time nor a running flag is knowable — both stay null.
    const intervals = this.callSafe(() => registry.getIntervals?.());
    for (const name of Array.isArray(intervals) ? intervals : []) {
      tasks.push(this.buildTask(name, 'interval', 'interval', null, null));
    }

    const timeouts = this.callSafe(() => registry.getTimeouts?.());
    for (const name of Array.isArray(timeouts) ? timeouts : []) {
      tasks.push(this.buildTask(name, 'timeout', 'timeout', null, null));
    }

    return tasks;
  }

  /** Resolve `SchedulerRegistry` structurally via the moduleRef; null on failure. */
  private resolveRegistry(moduleRef: ModuleRef | undefined): SchedulerRegistryLike | null {
    if (!moduleRef || typeof moduleRef.get !== 'function') return null;
    try {
      const found = moduleRef.get(SchedulerRegistry, { strict: false });
      if (found && typeof found === 'object') return found;
      return null;
    } catch {
      return null;
    }
  }

  /** Run a registry accessor, swallowing any throw (degrade to undefined). */
  private callSafe<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch {
      return undefined;
    }
  }

  private buildTask(
    name: string,
    kind: ScheduleKind,
    schedule: string,
    nextRunAt: string | null,
    running: boolean | null,
  ): ScheduledTask {
    const last = this.lastRuns.get(name);
    const safeKind: ScheduleKind = isScheduleKind(kind) ? kind : 'cron';
    return {
      name,
      kind: safeKind,
      schedule,
      nextRunAt,
      running,
      lastRunAt: last?.at ?? null,
      lastDurationMs: last?.durationMs ?? null,
      lastStatus: last?.status ?? null,
    };
  }
}
