// packages/bullmq/src/bull-mq-queue-manager.ts
import type {
  JobPage,
  QueueCounts,
  QueueJob,
  QueueJobDetail,
  QueueManager,
  QueueManagerContext,
  QueueState,
  QueueSummary,
} from '@dudousxd/nestjs-telescope';
import { DiscoveryService } from '@nestjs/core';
import { type QueueLike, discoverQueues } from './queue-discovery.js';

// BullMQ list names accepted by Queue.getJobs()/getJobCounts(). 'waiting' maps
// to the internal 'wait' list (BullMQ also accepts 'waiting' as an alias, but
// 'wait' is the canonical list name). 'paused' jobs live in their own list.
// Verified against bullmq@5.78.0 (JobType = JobState | 'paused' | 'repeat' | 'wait').
const STATE_TO_BULL: Record<QueueState, string> = {
  waiting: 'wait',
  active: 'active',
  delayed: 'delayed',
  failed: 'failed',
  completed: 'completed',
  paused: 'paused',
};
const DEFAULT_LIMIT = 50;

/** Duck-typed BullMQ Job; every field is optional so we never assume shape. */
interface BullJobLike {
  id?: string | null;
  name?: string;
  data?: unknown;
  opts?: unknown;
  attemptsMade?: number;
  timestamp?: number;
  processedOn?: number;
  finishedOn?: number;
  failedReason?: string;
  stacktrace?: string[];
  returnvalue?: unknown;
  progress?: number | object;
}

function isBullJobLike(value: unknown): value is BullJobLike {
  return typeof value === 'object' && value !== null;
}

function readMaxAttempts(opts: unknown): number | null {
  if (typeof opts === 'object' && opts !== null) {
    const attempts = (opts as { attempts?: unknown }).attempts;
    if (typeof attempts === 'number') return attempts;
  }
  return null;
}

/** Best-effort state for a single fetched job (detail view, non-critical). */
function deriveState(job: BullJobLike): QueueState {
  if (job.finishedOn != null) {
    return job.failedReason != null ? 'failed' : 'completed';
  }
  if (job.processedOn != null) return 'active';
  return 'waiting';
}

export class BullMqQueueManager implements QueueManager {
  readonly driver = 'bullmq';
  private queues = new Map<string, QueueLike>();
  private redact: (value: unknown) => unknown = (value) => value;

  /** @param queueNames optional explicit allow-list; default = auto-discover all. */
  constructor(private readonly queueNames?: string[]) {}

  init(ctx: QueueManagerContext): void {
    this.redact = ctx.redact;
    const discovery = ctx.moduleRef.get(DiscoveryService, { strict: false });
    for (const queue of discoverQueues(discovery)) {
      if (!this.queueNames || this.queueNames.includes(queue.name)) {
        this.queues.set(queue.name, queue);
      }
    }
  }

  private requireQueue(queue: string): QueueLike {
    const found = this.queues.get(queue);
    if (!found) throw new Error(`Unknown bullmq queue: ${queue}`);
    return found;
  }

  private async countsFor(queue: QueueLike): Promise<QueueCounts> {
    const counts = await queue.getJobCounts(
      'waiting',
      'active',
      'delayed',
      'failed',
      'completed',
      'paused',
    );
    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
      completed: counts.completed ?? 0,
      paused: counts.paused ?? 0,
    };
  }

  async listQueues(): Promise<QueueSummary[]> {
    return Promise.all(
      [...this.queues.values()].map(async (queue) => ({
        driver: this.driver,
        queue: queue.name,
        counts: await this.countsFor(queue),
        isPaused: await queue.isPaused(),
      })),
    );
  }

  counts(queue: string): Promise<QueueCounts> {
    return this.countsFor(this.requireQueue(queue));
  }

  async listJobs(
    queue: string,
    state: QueueState,
    page: { cursor?: string; limit?: number },
  ): Promise<JobPage> {
    const target = this.requireQueue(queue);
    const limit = page.limit && page.limit > 0 ? page.limit : DEFAULT_LIMIT;
    const start = page.cursor ? Math.max(0, Number.parseInt(page.cursor, 10) || 0) : 0;
    // Fetch one extra (end inclusive: start..start+limit) to detect a next page.
    const raw = await target.getJobs(STATE_TO_BULL[state], start, start + limit, false);
    const bullJobs = raw.filter(isBullJobLike);
    const jobs = bullJobs.slice(0, limit).map((job) => this.toJob(job, state));
    const nextCursor = bullJobs.length > limit ? String(start + limit) : null;
    return { jobs, nextCursor, total: null };
  }

  async getJob(queue: string, id: string): Promise<QueueJobDetail | null> {
    const raw = await this.requireQueue(queue).getJob(id);
    if (!isBullJobLike(raw)) return null;
    const base = this.toJob(raw, deriveState(raw));
    return {
      ...base,
      data: this.redact(raw.data),
      opts: raw.opts ?? null,
      stacktrace: Array.isArray(raw.stacktrace) ? raw.stacktrace : null,
      returnValue: raw.returnvalue ?? null,
    };
  }

  private toJob(job: BullJobLike, state: QueueState): QueueJob {
    return {
      id: String(job.id ?? ''),
      name: job.name ?? '',
      state,
      attemptsMade: job.attemptsMade ?? 0,
      maxAttempts: readMaxAttempts(job.opts),
      timestamp: job.timestamp ?? null,
      processedOn: job.processedOn ?? null,
      finishedOn: job.finishedOn ?? null,
      failedReason: job.failedReason ?? null,
      progress: typeof job.progress === 'number' ? job.progress : null,
    };
  }
}
