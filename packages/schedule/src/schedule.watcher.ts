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
import { DiscoveryService, MetadataScanner, type ModuleRef } from '@nestjs/core';
import { SchedulerRegistry } from '@nestjs/schedule';

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

/** Marks a prototype whose scheduled methods we've already wrapped. */
const PATCHED = Symbol.for('@dudousxd/nestjs-telescope:schedulePatched');

type AnyFn = (...args: unknown[]) => unknown;
type ProviderWrapper = { instance?: unknown };
type DiscoveryLike = { getProviders(): ProviderWrapper[] };

/** What we read off a `@nestjs/schedule` CronJob — structural, never the import. */
interface CronJobLike {
  cronTime?: { source?: unknown };
  nextDate?: () => unknown;
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
  if (typeof target !== 'function' && (typeof target !== 'object' || target === null)) {
    return undefined;
  }
  return Reflect.getMetadata(key, target as object);
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
 * At registration the watcher uses NestJS `DiscoveryService` + `MetadataScanner`
 * to find every provider method carrying a `@nestjs/schedule` metadata key
 * (`SCHEDULER_TYPE` / `SCHEDULE_*_OPTIONS`) and replaces it on the provider's
 * prototype with a wrapper that runs the original inside
 * `ctx.runInBatch('schedule', ...)` and records the run.
 *
 * Entries are recorded as `EntryType.Job` (a scheduled task *is* a job; the
 * `'schedule'` batch origin distinguishes it from a queue job), while the
 * watcher's own `type` is the string `'schedule'` so it surfaces distinctly in
 * `/meta`.
 *
 * The wrapper never swallows the host's error: on failure it records a `failed`
 * entry and re-throws so `@nestjs/schedule`'s own error handling is unaffected.
 *
 * @remarks
 * `@nestjs/schedule`'s explorer captures each handler reference at its own
 * `onModuleInit`. For the prototype patch to take effect, Telescope's module
 * must initialize **before** `ScheduleModule` (import it first / higher in the
 * module tree). If `ScheduleModule` initializes first, it will have bound the
 * un-wrapped handler and that task won't be captured (surfaced by the
 * "no scheduled methods found" warning only when nothing matched at all).
 */
export class ScheduleWatcher implements Watcher, ScheduleManager {
  /** String `type` (allowed by the SPI) so the watcher shows distinctly in
   *  `/meta`; entries themselves are recorded as `EntryType.Job`. */
  readonly type = 'schedule';
  private readonly logger = new Logger(ScheduleWatcher.name);
  private readonly slowMs: number;
  private readonly clock: { now(): number };
  private readonly scanner = new MetadataScanner();
  /** Prototypes already patched, so shared prototypes wrap exactly once. */
  private readonly patched = new WeakSet<object>();
  /** Last observed run per task name, fed by the record path (Schedule console). */
  private readonly lastRuns = new Map<string, LastRun>();
  /** Captured at register() so `listTasks` can resolve `SchedulerRegistry`. */
  private moduleRef: ModuleRef | undefined;

  constructor(options: ScheduleWatcherOptions = {}) {
    this.slowMs = options.slowMs ?? 1000;
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  register(ctx: WatcherContext): void {
    this.moduleRef = ctx.moduleRef;
    const discovery = ctx.moduleRef.get(DiscoveryService, { strict: false }) as DiscoveryLike;
    let count = 0;
    for (const wrapper of discovery.getProviders()) {
      const instance = wrapper.instance;
      if (!instance || typeof instance !== 'object') continue;
      const proto = Object.getPrototypeOf(instance) as (object & { [PATCHED]?: boolean }) | null;
      if (!proto || proto[PATCHED]) continue;

      const methodNames = this.methodNames(proto);
      let wrappedOnProto = 0;
      for (const name of methodNames) {
        const label = schedulerLabel((proto as Record<string, unknown>)[name]);
        if (!label) continue;
        this.patchMethod(proto as Record<string, AnyFn>, name, label, ctx);
        wrappedOnProto++;
      }
      if (wrappedOnProto > 0) {
        proto[PATCHED] = true;
        count += wrappedOnProto;
      }
    }
    if (count === 0) {
      this.logger.warn(
        'ScheduleWatcher: no @nestjs/schedule (@Cron/@Interval/@Timeout) methods found. ' +
          'Scheduled tasks will not be captured. Ensure Telescope initializes before ScheduleModule.',
      );
    } else {
      this.logger.log(`ScheduleWatcher: instrumented ${count} scheduled method(s).`);
    }
  }

  /** Method names on a prototype, via MetadataScanner when available (NestJS
   *  10/11), else a defensive own-property scan. */
  private methodNames(proto: object): string[] {
    const scanner = this.scanner as MetadataScanner & {
      getAllMethodNames?: (prototype: object) => string[];
    };
    if (typeof scanner.getAllMethodNames === 'function') {
      return scanner.getAllMethodNames(proto);
    }
    return Object.getOwnPropertyNames(proto).filter((name) => {
      if (name === 'constructor') return false;
      return typeof (proto as Record<string, unknown>)[name] === 'function';
    });
  }

  private patchMethod(
    proto: Record<string, AnyFn>,
    name: string,
    label: string,
    ctx: WatcherContext,
  ): void {
    const original = proto[name];
    if (typeof original !== 'function') return;
    const watcher = this;
    const schedulerName = (readMetadata(SCHEDULER_NAME, original) as string | undefined) ?? name;

    proto[name] = function patchedScheduled(this: unknown, ...args: unknown[]): unknown {
      return ctx.runInBatch('schedule', async () => {
        const startedAt = watcher.clock.now();
        try {
          const result = await original.apply(this, args);
          watcher.safeRecord(
            ctx,
            schedulerName,
            label,
            'completed',
            watcher.clock.now() - startedAt,
            undefined,
          );
          return result;
        } catch (error) {
          watcher.safeRecord(
            ctx,
            schedulerName,
            label,
            'failed',
            watcher.clock.now() - startedAt,
            error,
          );
          throw error; // never break the scheduled task
        }
      });
    };
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
        tasks.push(this.buildTask(name, 'cron', cronSource(job), cronNextRunAt(job)));
      }
    }

    const intervals = this.callSafe(() => registry.getIntervals?.());
    for (const name of Array.isArray(intervals) ? intervals : []) {
      tasks.push(this.buildTask(name, 'interval', 'interval', null));
    }

    const timeouts = this.callSafe(() => registry.getTimeouts?.());
    for (const name of Array.isArray(timeouts) ? timeouts : []) {
      tasks.push(this.buildTask(name, 'timeout', 'timeout', null));
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
  ): ScheduledTask {
    const last = this.lastRuns.get(name);
    const safeKind: ScheduleKind = isScheduleKind(kind) ? kind : 'cron';
    return {
      name,
      kind: safeKind,
      schedule,
      nextRunAt,
      lastRunAt: last?.at ?? null,
      lastDurationMs: last?.durationMs ?? null,
      lastStatus: last?.status ?? null,
    };
  }
}
