// packages/core/src/topology/remote-store.ts
//
// A tenant's store: every entry the recorder stores is shipped to the control plane (and kept in an
// optional local store for the app's own console). It sits innermost, so redaction, sampling,
// filters and tags already ran on every entry it sends.
import { Logger } from '@nestjs/common';
import type { Entry } from '../entry/entry.js';
import { runAsTelescopeWork } from '../otel/telescope-runtime.js';
import type {
  BoundedPruneResult,
  BoundedPruneScope,
  EntryQuery,
  EntryWithBatch,
  Page,
  PruneScope,
  StorageProvider,
  TagCount,
  TagQuery,
} from '../storage/storage-provider.js';
import { type TenantTokenSource, resolveTenantToken } from './tenant-auth.js';
import type { TenantTransport } from './transport.js';
import { type IngestBatch, ingestBatch } from './wire.js';

/** Shipping counters of a tenant, for its status and (later) its heartbeat. */
export interface ShippingStats {
  /** The transport's kind (`http`, or a broker). */
  transport: string;
  /** Entries waiting to be sent, including a batch being sent. */
  buffered: number;
  /** Entries dropped: the buffer was full, or the control plane can never take them. */
  dropped: number;
  /** Entries the control plane accepted. */
  sent: number;
  /** Sends that failed and will be retried. */
  failures: number;
  /** When the last batch was accepted, or `null`. */
  lastSentAt: Date | null;
  /** Why the last send failed, or `null` after a success. */
  lastError: string | null;
  /** Failed sends in a row (0 after a success). */
  consecutiveFailures: number;
  /** How long the oldest waiting entry has waited, in ms (0 with nothing waiting). */
  lagMs: number;
}

export interface RemoteTelescopeStoreOptions {
  transport: TenantTransport;
  partition: string;
  token: TenantTokenSource;
  /** Also keep entries here, for the app's own console. Default: none (the console reads nothing). */
  local?: StorageProvider;
  /** The most entries waiting to be sent; the oldest is dropped beyond it. Default 10 000. */
  bufferSize?: number;
  /** The most entries per batch. Default 200. */
  batchSize?: number;
  /**
   * The largest serialized batch, in bytes. A larger one is split; a single entry above it is
   * dropped. Default 64 000, under the 100 KB default JSON body limit of Express.
   */
  maxBatchBytes?: number;
  /** How often waiting entries are sent. Default 1 000 ms. */
  intervalMs?: number;
  /** First retry delay after a failed send, doubled per failure up to 30 s. Default 1 000 ms. */
  retryDelayMs?: number;
  /** How long `close()` keeps sending what is left. Default 5 000 ms. */
  shutdownTimeoutMs?: number;
  now?: () => number;
}

const MAX_RETRY_DELAY_MS = 30_000;

/** The tenant's {@link StorageProvider}: ships every stored entry to the control plane. */
export class RemoteTelescopeStore implements StorageProvider {
  private readonly logger = new Logger('TelescopeTenant');
  private readonly buffer: Entry[] = [];
  private inflight: { batch: IngestBatch; size: number } | null = null;
  private readonly shipped = new WeakSet<Entry[]>();
  private sending: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private retryAt = 0;
  /** The newest heartbeat not sent yet (only the newest is kept: it takes no buffer slot). */
  private heartbeat: unknown = undefined;
  private consecutiveFailures = 0;
  private readonly counters = {
    dropped: 0,
    sent: 0,
    failures: 0,
    lastSentAt: null as Date | null,
    lastError: null as string | null,
  };
  private readonly bufferSize: number;
  private readonly batchSize: number;
  private readonly maxBatchBytes: number;
  private readonly now: () => number;

  constructor(private readonly options: RemoteTelescopeStoreOptions) {
    this.bufferSize = Math.max(1, options.bufferSize ?? 10_000);
    this.batchSize = Math.max(1, options.batchSize ?? 200);
    this.maxBatchBytes = Math.max(1_024, options.maxBatchBytes ?? 64_000);
    this.now = options.now ?? Date.now;
  }

  /** The partition (app) this tenant sends as. */
  get partition(): string {
    return this.options.partition;
  }

  /** The transport's kind. */
  get transportKind(): string {
    return this.options.transport.kind;
  }

  stats(): ShippingStats {
    const oldest = this.inflight?.batch.entries[0]?.createdAt ?? this.buffer[0]?.createdAt;
    const oldestAt = oldest === undefined ? null : new Date(oldest).getTime();
    return {
      transport: this.options.transport.kind,
      buffered: this.buffer.length + (this.inflight?.size ?? 0),
      ...this.counters,
      consecutiveFailures: this.consecutiveFailures,
      lagMs: oldestAt === null ? 0 : Math.max(0, this.now() - oldestAt),
    };
  }

  /**
   * Sends `heartbeat` with the next batch (or alone when no entry waits). A newer one replaces
   * one not sent yet.
   */
  setHeartbeat(heartbeat: unknown): void {
    this.heartbeat = heartbeat;
  }

  async init(): Promise<void> {
    await this.options.local?.init?.();
    const interval = this.options.intervalMs ?? 1_000;
    this.timer = setInterval(() => void this.ship(), interval);
    this.timer.unref?.();
  }

  async store(entries: Entry[]): Promise<void> {
    // The recorder retries a failed store with the same array: queue it once.
    if (!this.shipped.has(entries)) {
      this.shipped.add(entries);
      this.enqueue(entries);
    }
    await this.options.local?.store(entries);
  }

  private enqueue(entries: Entry[]): void {
    this.buffer.push(...entries);
    const over = this.buffer.length - this.bufferSize;
    if (over > 0) {
      this.buffer.splice(0, over);
      this.drop(over, 'the send buffer is full');
    }
  }

  private drop(count: number, reason: string): void {
    if (count === 0) return;
    this.counters.dropped += count;
    this.logger.warn(`dropped ${count} ${count === 1 ? 'entry' : 'entries'}: ${reason}`);
  }

  /** Sends what is waiting, one batch at a time, until the buffer is empty or a send fails. */
  ship(options: { ignoreBackoff?: boolean } = {}): Promise<void> {
    if (this.sending) return this.sending;
    if (!options.ignoreBackoff && this.now() < this.retryAt) return Promise.resolve();
    this.sending = this.drain().finally(() => {
      this.sending = null;
    });
    return this.sending;
  }

  private async drain(): Promise<void> {
    for (;;) {
      if (this.inflight === null && !this.takeBatch()) return;
      const inflight = this.inflight;
      if (inflight === null) return;
      let result: Awaited<ReturnType<TenantTransport['send']>>;
      try {
        const token = await resolveTenantToken(this.options.token);
        // Telescope's own work: the send never picks up an app's trace (no `traceparent` on the
        // HTTP ingest call, no trace context on a broker job) and makes no OpenTelemetry spans.
        result = await runAsTelescopeWork(() =>
          this.options.transport.send(inflight.batch, {
            token,
            partition: this.options.partition,
          }),
        );
      } catch (error) {
        result = {
          status: 'retry',
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (result.status === 'sent') {
        this.inflight = null;
        this.consecutiveFailures = 0;
        this.retryAt = 0;
        this.counters.sent += inflight.size;
        this.counters.lastSentAt = new Date(this.now());
        this.counters.lastError = null;
        continue;
      }
      if (result.status === 'drop') {
        this.inflight = null;
        this.drop(inflight.size, result.reason);
        continue;
      }
      this.counters.failures += 1;
      this.counters.lastError = result.reason;
      this.consecutiveFailures += 1;
      const base = this.options.retryDelayMs ?? 1_000;
      const delay = Math.min(MAX_RETRY_DELAY_MS, base * 2 ** (this.consecutiveFailures - 1));
      this.retryAt = this.now() + delay;
      if (this.consecutiveFailures === 1 || this.consecutiveFailures % 10 === 0) {
        this.logger.warn(`sending to the control plane failed (will retry): ${result.reason}`);
      }
      return;
    }
  }

  /** Moves the next batch that fits {@link maxBatchBytes} into `inflight`. `false`: nothing left. */
  private takeBatch(): boolean {
    const heartbeat = this.heartbeat;
    while (this.buffer.length > 0) {
      let count = Math.min(this.batchSize, this.buffer.length);
      for (;;) {
        const batch = ingestBatch(this.buffer.slice(0, count), new Date(this.now()), heartbeat);
        if (Buffer.byteLength(JSON.stringify(batch), 'utf8') <= this.maxBatchBytes) {
          this.buffer.splice(0, count);
          this.inflight = { batch, size: count };
          this.heartbeat = undefined;
          return true;
        }
        if (count === 1) break;
        count = Math.ceil(count / 2);
      }
      this.buffer.shift();
      this.drop(1, `the entry is larger than maxBatchBytes (${this.maxBatchBytes})`);
    }
    if (heartbeat !== undefined) {
      // Nothing waits: the heartbeat goes alone.
      this.inflight = { batch: ingestBatch([], new Date(this.now()), heartbeat), size: 0 };
      this.heartbeat = undefined;
      return true;
    }
    return false;
  }

  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // A real-time budget: shutdown waits on real sends whatever clock the store was given.
    const deadline = Date.now() + (this.options.shutdownTimeoutMs ?? 5_000);
    while (this.buffer.length > 0 || this.inflight !== null || this.heartbeat !== undefined) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await Promise.race([
        this.ship({ ignoreBackoff: true }),
        new Promise((resolve) => setTimeout(resolve, remaining).unref?.()),
      ]);
      if (this.consecutiveFailures > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)).unref?.());
      }
    }
    const left = this.buffer.length + (this.inflight?.size ?? 0);
    if (left > 0) this.drop(left, 'the app shut down before they were sent');
    await this.options.transport.close?.();
    await this.options.local?.close?.();
  }

  // Reads come from the local copy; without one the app's own console is empty.

  async update(id: string, patch: Partial<Entry>): Promise<void> {
    await this.options.local?.update(id, patch);
  }

  async find(id: string): Promise<EntryWithBatch | null> {
    return this.options.local ? this.options.local.find(id) : null;
  }

  async get(query: EntryQuery): Promise<Page<Entry>> {
    return this.options.local ? this.options.local.get(query) : { data: [], nextCursor: null };
  }

  async batch(batchId: string): Promise<Entry[]> {
    return this.options.local ? this.options.local.batch(batchId) : [];
  }

  async tags(prefix?: string, query?: TagQuery): Promise<TagCount[]> {
    return this.options.local ? this.options.local.tags(prefix, query) : [];
  }

  async prune(olderThan: Date, keepLast?: number): Promise<number> {
    return this.options.local ? this.options.local.prune(olderThan, keepLast) : 0;
  }

  async pruneScoped(input: PruneScope): Promise<number> {
    const local = this.options.local;
    if (!local) return 0;
    return local.pruneScoped ? local.pruneScoped(input) : local.prune(input.before, input.keepLast);
  }

  async pruneScopedBatch(input: BoundedPruneScope): Promise<BoundedPruneResult> {
    const local = this.options.local;
    if (!local) return { deleted: 0, hasMore: false };
    if (local.pruneScopedBatch) return local.pruneScopedBatch(input);
    const { limit: _limit, ...scope } = input;
    const deleted = local.pruneScoped
      ? await local.pruneScoped(scope)
      : await local.prune(input.before);
    return { deleted, hasMore: false };
  }

  async clear(): Promise<void> {
    await this.options.local?.clear();
  }
}
