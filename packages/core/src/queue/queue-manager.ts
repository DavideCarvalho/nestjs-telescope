// packages/core/src/queue/queue-manager.ts
import type { ModuleRef } from '@nestjs/core';
import type { ResolvedCoreConfig } from '../config/options.js';

export type QueueState = 'waiting' | 'active' | 'delayed' | 'failed' | 'completed' | 'paused';

export const QUEUE_STATES: readonly QueueState[] = [
  'waiting',
  'active',
  'delayed',
  'failed',
  'completed',
  'paused',
];

export function isQueueState(value: unknown): value is QueueState {
  return typeof value === 'string' && (QUEUE_STATES as readonly string[]).includes(value);
}

export interface QueueCounts {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
  paused: number;
}
export interface QueueSummary {
  driver: string;
  queue: string;
  counts: QueueCounts;
  isPaused: boolean;
  /**
   * Optional per-queue capability hint: the mutating actions this specific
   * queue supports. Lets the UI show action buttons (e.g. Redrive) only for
   * queues that actually support them — for SQS, only queues with a configured
   * DLQ advertise `'redrive'`. Omitted by managers that don't vary per queue.
   */
  actions?: QueueActionName[];
}
export interface QueueJob {
  id: string;
  name: string;
  state: QueueState;
  attemptsMade: number;
  maxAttempts: number | null;
  timestamp: number | null;
  processedOn: number | null;
  finishedOn: number | null;
  failedReason: string | null;
  progress: number | null;
}
export interface QueueJobDetail extends QueueJob {
  data: unknown;
  opts: unknown;
  stacktrace: string[] | null;
  returnValue: unknown;
}
export interface JobPage {
  jobs: QueueJob[];
  nextCursor: string | null;
  total: number | null;
}

/** Handed to each QueueManager at boot (mirrors WatcherContext). */
export interface QueueManagerContext {
  readonly moduleRef: ModuleRef;
  readonly config: ResolvedCoreConfig;
  /** Redact a job payload before it leaves the server (core redaction). */
  readonly redact: (value: unknown) => unknown;
}

export interface QueueManager {
  readonly driver: string;
  init(ctx: QueueManagerContext): void | Promise<void>;
  listQueues(): Promise<QueueSummary[]>;
  counts(queue: string): Promise<QueueCounts>;
  listJobs(
    queue: string,
    state: QueueState,
    page: { cursor?: string; limit?: number },
  ): Promise<JobPage>;
  getJob(queue: string, id: string): Promise<QueueJobDetail | null>;
  // actions — Phase 2 (optional; presence advertises capability):
  retry?(queue: string, id: string): Promise<void>;
  remove?(queue: string, id: string): Promise<void>;
  promote?(queue: string, id: string): Promise<void>;
  retryAll?(queue: string, state: QueueState): Promise<number>;
  redrive?(queue: string): Promise<number>;
}

export type QueueActionName = 'retry' | 'remove' | 'promote' | 'retry-all' | 'redrive';

export const QUEUE_ACTIONS: readonly QueueActionName[] = [
  'retry',
  'remove',
  'promote',
  'retry-all',
  'redrive',
];

export function isQueueAction(value: unknown): value is QueueActionName {
  return typeof value === 'string' && (QUEUE_ACTIONS as readonly string[]).includes(value);
}

/** What the action authorizer is told about a requested mutation. */
export interface QueueActionRequest {
  driver: string;
  queue: string;
  action: QueueActionName;
  jobId?: string;
  state?: QueueState; // for retry-all
}
