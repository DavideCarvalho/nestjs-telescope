// packages/sqs/src/sqs-queue-manager.ts
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
import type { SqsOps, SqsQueueConfig } from './sqs-client.js';

/** Default cap for a DLQ snapshot (SQS ReceiveMessage maxes out at 10). */
const DEFAULT_DLQ_LIMIT = 10;

export interface SqsQueueManagerOptions {
  /** The SQS operations port — `createAwsSqsOps(client)` or a host impl. */
  ops: SqsOps;
  /** The queues to expose (name + source URL + DLQ URL). */
  queues: SqsQueueConfig[];
}

/** A DLQ message we received and cached so `getJob` can return its body later. */
interface CachedDlqMessage {
  body: string;
  attributes?: Record<string, string>;
}

function readReceiveCount(attributes: Record<string, string> | undefined): number {
  const raw = attributes?.ApproximateReceiveCount;
  if (typeof raw !== 'string') return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Parse a DLQ body as JSON, falling back to the raw string when it isn't JSON. */
function parseBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

const EMPTY_PAGE: JobPage = { jobs: [], nextCursor: null, total: null };

/**
 * Read-and-redrive manager for SQS dead-letter queues.
 *
 * SQS has no "list all messages" primitive — you can only ReceiveMessage (which
 * temporarily hides messages) and read queue-depth approximations. So this
 * manager is **DLQ-only**:
 *
 * - `listQueues`/`counts` report approximate depths (source visible→waiting,
 *   source in-flight→active, DLQ visible→failed).
 * - `listJobs` is meaningful only for `state === 'failed'`: it snapshots the DLQ
 *   via `receiveDlq` (never deleting — messages reappear after the visibility
 *   timeout) and caches each received message so `getJob` can return its body
 *   (received SQS messages aren't refetchable by id). Every other state is empty.
 * - The single mutation is `redrive` (native `StartMessageMoveTask`). There is no
 *   `retry`/`remove`/`promote`/`retryAll`.
 *
 * DLQ bodies pass through `ctx.redact` before they leave the server, matching the
 * BullMQ manager's security property.
 */
export class SqsQueueManager implements QueueManager {
  readonly driver = 'sqs';
  private readonly ops: SqsOps;
  private readonly queues = new Map<string, SqsQueueConfig>();
  private readonly dlqCache = new Map<string, Map<string, CachedDlqMessage>>();
  private redact: (value: unknown) => unknown = (value) => value;

  constructor(options: SqsQueueManagerOptions) {
    this.ops = options.ops;
    for (const queue of options.queues) {
      this.queues.set(queue.name, queue);
    }
  }

  init(ctx: QueueManagerContext): void {
    this.redact = ctx.redact;
  }

  private requireQueue(queue: string): SqsQueueConfig {
    const found = this.queues.get(queue);
    if (!found) throw new Error(`Unknown sqs queue: ${queue}`);
    return found;
  }

  private async countsFor(config: SqsQueueConfig): Promise<QueueCounts> {
    const [source, dlq] = await Promise.all([
      this.ops.approximateCounts(config.url),
      this.ops.approximateCounts(config.dlqUrl),
    ]);
    return {
      waiting: source.visible,
      active: source.notVisible,
      delayed: 0,
      failed: dlq.visible,
      completed: 0,
      paused: 0,
    };
  }

  async listQueues(): Promise<QueueSummary[]> {
    return Promise.all(
      [...this.queues.values()].map(async (config) => ({
        driver: this.driver,
        queue: config.name,
        counts: await this.countsFor(config),
        isPaused: false,
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
    const config = this.requireQueue(queue);
    // SQS can only browse the DLQ (failed). Every other state is empty.
    if (state !== 'failed') return EMPTY_PAGE;

    const limit =
      page.limit && page.limit > 0 ? Math.min(page.limit, DEFAULT_DLQ_LIMIT) : DEFAULT_DLQ_LIMIT;
    const messages = await this.ops.receiveDlq(config.dlqUrl, limit);

    const cache = new Map<string, CachedDlqMessage>();
    const jobs: QueueJob[] = messages.map((message) => {
      cache.set(
        message.id,
        message.attributes
          ? { body: message.body, attributes: message.attributes }
          : { body: message.body },
      );
      return {
        id: message.id,
        name: config.name,
        state: 'failed',
        attemptsMade: readReceiveCount(message.attributes),
        maxAttempts: null,
        timestamp: null,
        processedOn: null,
        finishedOn: null,
        failedReason: null,
        progress: null,
      };
    });
    // Replace the snapshot cache for this queue (messages aren't refetchable by id).
    this.dlqCache.set(config.name, cache);

    // No real pagination — ReceiveMessage returns an arbitrary best-effort batch.
    return { jobs, nextCursor: null, total: null };
  }

  async getJob(queue: string, id: string): Promise<QueueJobDetail | null> {
    const config = this.requireQueue(queue);
    const cached = this.dlqCache.get(config.name)?.get(id);
    if (!cached) return null;
    return {
      id,
      name: config.name,
      state: 'failed',
      attemptsMade: readReceiveCount(cached.attributes),
      maxAttempts: null,
      timestamp: null,
      processedOn: null,
      finishedOn: null,
      failedReason: null,
      progress: null,
      data: this.redact(parseBody(cached.body)),
      opts: null,
      stacktrace: null,
      returnValue: null,
    };
  }

  /**
   * Redrive the DLQ back to its source queue via native `StartMessageMoveTask`.
   * Returns the best-effort pre-redrive failed (DLQ visible) count.
   */
  async redrive(queue: string): Promise<number> {
    const config = this.requireQueue(queue);
    const [dlqArn, sourceArn, dlqCounts] = await Promise.all([
      this.ops.queueArn(config.dlqUrl),
      this.ops.queueArn(config.url),
      this.ops.approximateCounts(config.dlqUrl),
    ]);
    await this.ops.redrive(dlqArn, sourceArn);
    return dlqCounts.visible;
  }
}
