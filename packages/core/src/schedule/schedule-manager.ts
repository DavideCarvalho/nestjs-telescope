// packages/core/src/schedule/schedule-manager.ts
import type { ModuleRef } from '@nestjs/core';
import type { ResolvedCoreConfig } from '../config/options.js';

export type ScheduleKind = 'cron' | 'interval' | 'timeout';

export const SCHEDULE_KINDS: readonly ScheduleKind[] = ['cron', 'interval', 'timeout'];

export function isScheduleKind(value: unknown): value is ScheduleKind {
  return typeof value === 'string' && (SCHEDULE_KINDS as readonly string[]).includes(value);
}

export type ScheduleRunStatus = 'completed' | 'failed';

/**
 * A registered `@nestjs/schedule` task as surfaced to the Schedule console.
 * `schedule` is the cron expression for crons, or a `"every Nms"` label for
 * intervals/timeouts. Last-run fields come from the watcher's recorded runs and
 * are `null` until a run has been observed (or when no manager tracks them).
 */
export interface ScheduledTask {
  name: string;
  kind: ScheduleKind;
  schedule: string;
  /** ISO timestamp of the next fire, or null when unknown (intervals/timeouts). */
  nextRunAt: string | null;
  /**
   * Whether the task is currently active (started/enabled). For crons this is the
   * underlying `CronJob.running` flag — `false` means the cron is registered but
   * stopped, so it WON'T fire even though it has a schedule. `null` when the
   * source can't report it (intervals/timeouts expose only their name through
   * `SchedulerRegistry`, so their running state is unknowable).
   */
  running: boolean | null;
  /** ISO timestamp of the last observed run, or null. */
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastStatus: ScheduleRunStatus | null;
}

/** Handed to each ScheduleManager at boot (mirrors QueueManagerContext). */
export interface ScheduleManagerContext {
  readonly moduleRef: ModuleRef;
  readonly config: ResolvedCoreConfig;
}

/**
 * SPI for a source of scheduled tasks. The `@nestjs/schedule` watcher implements
 * this directly (it already discovers the tasks + records runs), reading
 * `SchedulerRegistry` for schedule + next-run and merging its own last-run map.
 */
export interface ScheduleManager {
  init?(ctx: ScheduleManagerContext): void | Promise<void>;
  listTasks(ctx: ScheduleManagerContext): Promise<ScheduledTask[]>;
}
