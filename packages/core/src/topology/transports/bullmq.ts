// packages/core/src/topology/transports/bullmq.ts
//
// BullMQ: one job per batch. `bullmq` is an optional peer, imported only when this driver is used.
import { createHash } from 'node:crypto';
import {
  type TenantTransport,
  type TransportListener,
  importPeer,
  isDeadLetter,
} from '../transport.js';
import type { IngestEnvelope } from '../wire.js';

/** The part of `bullmq` this driver uses. */
export interface BullmqModule {
  Queue: new (
    name: string,
    options: { connection: unknown; prefix?: string },
  ) => {
    add(name: string, data: unknown, options?: Record<string, unknown>): Promise<unknown>;
    close(): Promise<void>;
  };
  Worker: new (
    name: string,
    processor: (job: { data: unknown; attemptsMade: number }) => Promise<unknown>,
    options: { connection: unknown; prefix?: string; concurrency?: number },
  ) => {
    close(): Promise<void>;
    on?(event: string, listener: (...args: unknown[]) => void): unknown;
  };
  UnrecoverableError: new (message?: string) => Error;
}

export interface BullmqTransportOptions {
  /** BullMQ's `connection` (ioredis options or an instance). */
  connection: unknown;
  /** The queue name. Default `telescope-ingest`. */
  queue?: string;
  /** BullMQ's key prefix. Default BullMQ's (`bull`). */
  prefix?: string;
  /** Attempts per job before it lands in the failed set (the dead letters). Default 5. */
  attempts?: number;
  /** Jobs the control plane handles at once. Default 1. */
  concurrency?: number;
  /** A larger message is dead-lettered unread. Default 1 MiB. */
  maxMessageBytes?: number;
  /** Failed jobs kept as dead letters. Default 10 000. */
  keepFailed?: number;
  /** The `bullmq` module, instead of importing it (a bundled app, tests). */
  bullmq?: BullmqModule;
}

const DEFAULT_QUEUE = 'telescope-ingest';

/**
 * Tenants add one job per batch (the job id is derived from the batch id, so a resent batch is one
 * job); the control plane runs a worker. Dead letters: BullMQ's failed set (via
 * `UnrecoverableError`), bounded by `keepFailed`. A transient failure (the store or the verifier is
 * down) is retried up to `attempts` with exponential backoff.
 */
export function bullmqTransport(options: BullmqTransportOptions): TenantTransport {
  if (options.connection === undefined) {
    throw new Error('telescope transports.bullmq: `connection` is required.');
  }
  const name = options.queue ?? DEFAULT_QUEUE;
  const attempts = Math.max(1, options.attempts ?? 5);
  const maxBytes = options.maxMessageBytes ?? 1024 * 1024;
  const base = {
    connection: options.connection,
    ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
  };
  let loaded: Promise<BullmqModule> | undefined;
  const load = (): Promise<BullmqModule> => {
    loaded ??= options.bullmq
      ? Promise.resolve(options.bullmq)
      : importPeer<BullmqModule>('bullmq', 'bullmq');
    return loaded;
  };
  let queue: InstanceType<BullmqModule['Queue']> | undefined;

  return {
    kind: 'bullmq',
    async send(batch, { token, partition }) {
      try {
        const bullmq = await load();
        queue ??= new bullmq.Queue(name, base);
        const envelope: IngestEnvelope = { ...batch, token, partition };
        await queue.add('batch', envelope, {
          // BullMQ ids may not contain ':'; a hash keeps one job per (partition, batch).
          jobId: createHash('sha256').update(`${partition}\0${batch.id}`).digest('hex'),
          attempts,
          backoff: { type: 'exponential', delay: 1_000 },
          removeOnComplete: true,
          removeOnFail: { count: options.keepFailed ?? 10_000 },
        });
        return { status: 'sent' };
      } catch (error) {
        return {
          status: 'retry',
          reason: `bullmq add failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    async listen(handler, logger): Promise<TransportListener> {
      const bullmq = await load();
      const worker = new bullmq.Worker(
        name,
        async (job) => {
          const size = Buffer.byteLength(JSON.stringify(job.data) ?? '', 'utf8');
          if (size > maxBytes) {
            logger.warn(`dead-lettered a batch of ${size} bytes (maxMessageBytes ${maxBytes})`);
            throw new bullmq.UnrecoverableError('message too large');
          }
          const data = (job.data ?? {}) as Partial<IngestEnvelope>;
          const outcome = await handler({ token: data.token, body: data });
          if (outcome.status === 'stored') return { stored: outcome.stored };
          const reason = 'reason' in outcome ? outcome.reason : outcome.status;
          if (isDeadLetter(outcome.status)) {
            logger.warn(`dead-lettered a batch: ${reason}`);
            throw new bullmq.UnrecoverableError(reason);
          }
          throw new Error(reason);
        },
        { ...base, concurrency: options.concurrency ?? 1 },
      );
      // A worker without an error listener logs connection errors to the console itself.
      worker.on?.('error', (error: unknown) =>
        logger.warn(`bullmq worker: ${error instanceof Error ? error.message : String(error)}`),
      );
      return { stop: () => worker.close() };
    },
    async close() {
      await queue?.close();
    },
  };
}
