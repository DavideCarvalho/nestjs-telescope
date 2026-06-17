import type { SamplingConfig } from '../config/options.js';
import { passesSampling } from '../config/sampling.js';
import type { ContextAccessor } from '../context/context-accessor.js';
import type { TelescopeContext } from '../context/telescope-context.js';
// packages/core/src/recorder/recorder.ts
import type { Entry, RecordInput } from '../entry/entry.js';
import type { CompiledRedactSpec, RedactOptions } from '../redaction/redact.js';
import { compileRedactSpec, redactBoundedWith } from '../redaction/redact.js';
import { aggregateDeltas } from '../rollup/aggregate-deltas.js';
import { isRollupStore } from '../rollup/rollup-store.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import type { Tagger } from '../tagging/tagger.js';
import { runTaggers } from '../tagging/tagger.js';
import type { TraceContext, TraceContextProvider } from '../trace/trace-context-provider.js';

export type DropReason = 'overflow' | 'store-failed' | 'record-error';

/**
 * Default backoff seam: an unref'd `setTimeout` so a pending retry never keeps
 * the host's event loop alive (e.g. during shutdown). Injectable for tests.
 */
function defaultUnrefDelay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Cheap, hot-path-safe self-observability counters describing the Recorder's
 * own behaviour. Every field is a plain integer/number snapshot — no per-call
 * timing is taken on the synchronous `record()` path. Flush timing is measured
 * off the host path inside `flush()`.
 */
export interface RecorderSelfMetrics {
  /** Total entries that passed sampling+filter and were buffered. */
  recorded: number;
  /** Ring-buffer capacity. */
  bufferSize: number;
  /** Entries currently held in the ring. */
  bufferUsed: number;
  /** Maximum `bufferUsed` ever observed. */
  bufferHighWater: number;
  /** Number of flushes that drained at least one entry. */
  flushes: number;
  /** Cumulative entries drained across all flushes. */
  flushedEntries: number;
  /**
   * Number of flush batches that failed their first `store()` and were retried
   * once. A non-zero, climbing value means the storage backend is flaky; pair
   * it with `storeFailedDropped` to see how many retries still ended in a drop.
   */
  retriedFlushes: number;
  /** Wall-clock duration of the most recent draining flush, or null. */
  lastFlushMs: number | null;
  /** Largest flush duration ever observed, or null. */
  maxFlushMs: number | null;
  /** Cumulative flush duration across all draining flushes. */
  totalFlushMs: number;
  /** Entries evicted because the ring was full. */
  overflowDropped: number;
  /** Entries dropped because the storage provider rejected a batch. */
  storeFailedDropped: number;
  /** Sum of all drop buckets (overflow + store-failed + record-error). */
  droppedCount: number;
  /**
   * Entries whose content hit a redaction bound and was clipped (depth, string,
   * array, or node budget). A non-zero, climbing value means hosts are capturing
   * fat content (e.g. ORM entities) — a signal to project lighter content or add
   * per-type `sampling`. The entry is still recorded; only its payload is bounded.
   */
  truncatedCount: number;
}

export interface RecorderOptions {
  storage: StorageProvider;
  context: TelescopeContext;
  instanceId: string;
  taggers: Tagger[];
  redact: RedactOptions;
  /**
   * Per-type sampling. A value may be a bare keep-rate (0..1) or a
   * {@link SamplingRule} object that additionally keeps errors / slow entries.
   * Missing type ⇒ falls back to `default`, else keep.
   */
  sampling: SamplingConfig;
  bufferSize: number;
  /**
   * Maximum entries handed to a single `storage.store()` call. When set and a
   * flush drains more than this, the drained entries are sliced into sequential
   * chunks of at most this size, each stored (with its own bounded retry) in
   * oldest→newest order. Bounds the per-store payload so a large flush can't
   * spike storage memory/latency. When unset (or >= the drained count) the whole
   * batch is stored in one call, preserving the original behaviour.
   */
  flushBatchSize?: number;
  /**
   * Backoff (ms) before the single bounded retry of a failed `store()` batch.
   * Defaults to 1000ms. The retry happens inside the same in-flight flush
   * promise, so the `flushing` serialization still prevents pileups.
   */
  retryDelayMs?: number;
  now?: () => number;
  random?: () => number;
  /**
   * Injectable delay seam used between the failed first store and its retry.
   * Defaults to an unref'd `setTimeout` so it never keeps the event loop alive.
   * Tests inject a resolved/controllable promise for determinism.
   */
  delay?: (ms: number) => Promise<void>;
  idFactory: () => string;
  /**
   * Called (inside a try/catch) whenever entries are dropped, with the count
   * and reason. A faulty hook will not propagate into the Recorder.
   *
   * Reasons:
   * - `'overflow'`      — the ring buffer was full; the oldest entry was evicted.
   * - `'store-failed'`  — the storage provider rejected a batch; the batch is dropped.
   * - `'record-error'`  — an unexpected error occurred inside `record()`.
   */
  onDrop?: (count: number, reason: DropReason) => void;
  /**
   * Final allow/deny predicate applied to the enriched entry; returning false
   * excludes it (an intentional exclusion, not counted as a drop).
   */
  filter?: (entry: Entry) => boolean;
  /** Optional ambient trace-context source; read once per recorded entry. */
  traceContext?: TraceContextProvider;
  /**
   * Optional, soft-detected `@dudousxd/nestjs-context` accessor (structurally
   * mirrored as {@link ContextAccessor}). When present it enriches each recorded
   * entry as a SECONDARY correlation source, additive to the OTel
   * {@link traceContext}:
   *
   * - **traceId precedence**: OTel wins. The context `traceId()` is used ONLY as
   *   a FALLBACK when {@link traceContext} did not yield one for this entry. An
   *   existing OTel trace id is never clobbered, so cross-lib correlation with
   *   durable/notifications (which share nestjs-context) kicks in only when OTel
   *   is absent.
   * - **user/tenant tags**: when available, `user:<Type>#<id>` and
   *   `tenant:<id>` tags are appended (before taggers run, so taggers/filters
   *   can see them) — letting the dashboard group/filter by user and tenant.
   *
   * Read defensively once per entry; a misbehaving accessor degrades to no
   * enrichment and never throws into `record()`.
   */
  contextAccessor?: ContextAccessor;
  /**
   * Best-effort hook fired with the entries a flush JUST persisted (after a
   * successful `store()`, before the next flush). Powers per-flush alert
   * evaluation (the `new-exception` rule) without coupling the Recorder to the
   * alerter. Called inside a try/catch — a faulty hook is swallowed and can never
   * break the flush or the host. NOT called for a batch that failed to store.
   */
  onFlushStored?: (entries: Entry[]) => void | Promise<void>;
}

/**
 * Buffers {@link Entry} objects in a fixed-capacity O(1) ring buffer and
 * periodically flushes them to a {@link StorageProvider}.
 *
 * **Overflow policy** — overflow drops the OLDEST buffered entry (so under
 * sustained overload a batch may be stored without its earliest entries);
 * recent activity is preferred.
 *
 * **Storage failures** — when `store()` rejects, the drained batch is retried
 * exactly ONCE after a bounded backoff (`retryDelayMs`, default 1000ms). Only a
 * second failure drops the batch (fail-open, never grow). The retry runs inside
 * the single in-flight `flushing` promise, so failed batches never pile up and
 * the ring keeps absorbing/evicting meanwhile — memory stays bounded. Drops are
 * surfaced via `onDrop` and the `storeFailedDropped` / `droppedCount` counters;
 * each retried batch increments the `retriedFlushes` self-metric.
 */
export class Recorder {
  // ── Ring-buffer state ──────────────────────────────────────────────────────
  private readonly ring: (Entry | undefined)[];
  /** Index of the oldest entry in the ring. */
  private head = 0;
  /** Number of valid entries currently held. */
  private count = 0;

  // ── Drop counters ──────────────────────────────────────────────────────────
  private overflowDrops = 0;
  private storeFailedDrops = 0;
  private recordErrorDrops = 0;

  // ── Self-metrics counters (cheap, hot-path-safe) ───────────────────────────
  private recordedCount = 0;
  private highWaterCount = 0;
  private flushCount = 0;
  private flushedEntriesCount = 0;
  /** Flush batches that failed their first store() and were retried once. */
  private retriedFlushCount = 0;
  private lastFlushDurationMs: number | null = null;
  private maxFlushDurationMs: number | null = null;
  private totalFlushDurationMs = 0;
  /** Entries whose content was clipped by a redaction bound (incident guard). */
  private truncatedEntryCount = 0;

  // ── Concurrency guard ─────────────────────────────────────────────────────
  private flushing: Promise<void> | null = null;

  // ── Overload protection ────────────────────────────────────────────────────
  /**
   * When paused, `record()` becomes a no-op (the entry is dropped, counted as an
   * overflow drop) so a telescope under load can never amplify an incident. Set
   * by the overhead guard when event-loop lag crosses its threshold; cleared
   * when lag recovers. Flushing continues so the buffer still drains.
   */
  private paused = false;

  // ── Determinism seams ─────────────────────────────────────────────────────
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly retryDelayMs: number;
  /**
   * Redaction key/path Sets compiled ONCE at boot from `options.redact`. Config
   * is immutable after construction, so rebuilding these per entry (in the
   * hottest function) was pure waste — they are precompiled here and reused on
   * every `enrich()` via {@link redactBoundedWith}.
   */
  private readonly redactSpec: CompiledRedactSpec;

  constructor(private readonly options: RecorderOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    this.delay = options.delay ?? defaultUnrefDelay;
    this.redactSpec = compileRedactSpec(options.redact);
    // Pre-size the ring so slot access is always O(1).
    this.ring = new Array<Entry | undefined>(options.bufferSize).fill(undefined);
  }

  // ── Public getters ─────────────────────────────────────────────────────────

  get overflowDropped(): number {
    return this.overflowDrops;
  }

  get storeFailedDropped(): number {
    return this.storeFailedDrops;
  }

  /** Sum of all drop buckets (overflow + store-failed + record-error). */
  get droppedCount(): number {
    return this.overflowDrops + this.storeFailedDrops + this.recordErrorDrops;
  }

  /**
   * Number of ring slots still holding an entry reference. After a flush this
   * MUST equal `bufferUsed` (only the live, not-yet-drained entries), never the
   * stale entries a previous flush left behind.
   *
   * @internal Test-only seam to assert `drain()` nulls drained slots so fat
   * entries don't linger in the ring after a flush. Not part of the public API.
   */
  get retainedSlotCount(): number {
    let retained = 0;
    for (const slot of this.ring) {
      if (slot !== undefined) {
        retained += 1;
      }
    }
    return retained;
  }

  /**
   * Snapshot of the Recorder's own behaviour. All fields are cheap integer
   * counters accumulated on the hot path plus off-path flush timings — no
   * per-record timing is taken, so reading this never taxes `record()`.
   */
  getSelfMetrics(): RecorderSelfMetrics {
    return {
      recorded: this.recordedCount,
      bufferSize: this.options.bufferSize,
      bufferUsed: this.count,
      bufferHighWater: this.highWaterCount,
      flushes: this.flushCount,
      flushedEntries: this.flushedEntriesCount,
      retriedFlushes: this.retriedFlushCount,
      lastFlushMs: this.lastFlushDurationMs,
      maxFlushMs: this.maxFlushDurationMs,
      totalFlushMs: this.totalFlushDurationMs,
      overflowDropped: this.overflowDrops,
      storeFailedDropped: this.storeFailedDrops,
      droppedCount: this.droppedCount,
      truncatedCount: this.truncatedEntryCount,
    };
  }

  /**
   * On-demand micro-benchmark of the synchronous capture path (sampling check +
   * enrich + filter) on a representative input, WITHOUT enqueuing into the ring
   * or touching storage. Returns the mean nanoseconds per call. Lives here so
   * the "cost per capture" figure is honest yet never instruments live records.
   */
  benchmarkRecordCost(iterations: number): number {
    if (iterations <= 0) {
      return 0;
    }
    const sample: RecordInput = {
      type: 'query',
      content: { sql: 'select * from t where id = ?', bindings: [1], took: 1 },
    };
    // Warm up so JIT compilation is not charged to the measured window.
    for (let warmup = 0; warmup < iterations; warmup++) {
      this.measureCaptureOnce(sample);
    }
    const start = process.hrtime.bigint();
    for (let iteration = 0; iteration < iterations; iteration++) {
      this.measureCaptureOnce(sample);
    }
    const elapsedNanos = process.hrtime.bigint() - start;
    return Number(elapsedNanos) / iterations;
  }

  /**
   * Runs the same sampling+enrich+filter logic as `record()` but discards the
   * enriched entry instead of buffering it. Used only by the benchmark.
   */
  private measureCaptureOnce(input: RecordInput): void {
    if (!this.passesSampling(input)) {
      return;
    }
    const entry = this.enrich(input);
    if (this.options.filter !== undefined) {
      this.options.filter(entry);
    }
  }

  // ── Core API ───────────────────────────────────────────────────────────────

  /**
   * Whether capture is currently paused by the overhead guard. While paused,
   * `record()` drops new entries (counted as an overflow drop) but flushing
   * continues so the buffer drains.
   */
  get isPaused(): boolean {
    return this.paused;
  }

  /** Pause capture: `record()` becomes a dropping no-op until {@link resume}. */
  pause(): void {
    this.paused = true;
  }

  /** Resume capture after a {@link pause}. */
  resume(): void {
    this.paused = false;
  }

  /** Synchronous, O(1), never throws into the caller. */
  record(input: RecordInput): void {
    try {
      // Overload guard: while paused, drop new entries (counted as overflow) so
      // a telescope under load can never amplify an incident. Flushing still
      // drains whatever is already buffered.
      if (this.paused) {
        this.overflowDrops += 1;
        this.notifyDrop(1, 'overflow');
        return;
      }
      if (!this.passesSampling(input)) {
        return;
      }
      const entry = this.enrich(input);
      if (this.options.filter !== undefined && !this.options.filter(entry)) {
        // Intentional exclusion — not a drop, no counter increment.
        return;
      }
      this.push(entry);
    } catch {
      // A telescope bug must never break the host. Swallow.
      this.recordErrorDrops += 1;
      this.notifyDrop(1, 'record-error');
    }
  }

  /**
   * Drains the buffer and persists via {@link StorageProvider.store}.
   * Concurrent calls share the same in-flight promise — entries added
   * while a flush is running are picked up on the next flush.
   */
  async flush(): Promise<void> {
    if (this.flushing !== null) {
      return this.flushing;
    }

    if (this.count === 0) {
      return;
    }

    // Drain synchronously before first await so record() calls that arrive
    // after this point are buffered for the next flush.
    const drained = this.drain();

    // Off the host path: timing the flush here is safe. Use the `now()` seam so
    // tests stay deterministic, consistent with how the rest of the Recorder
    // reads wall time.
    const flushStartedAt = this.now();

    const storage = this.options.storage;
    this.flushing = this.storeDrained(storage, drained).finally(() => {
      this.recordFlushMetrics(drained.length, this.now() - flushStartedAt);
      this.flushing = null;
    });

    return this.flushing;
  }

  /**
   * Persists a drained batch, chunked by `flushBatchSize` when that bounds the
   * batch. Each chunk is stored sequentially (oldest→newest) with its own
   * bounded retry; per-chunk rollups + the `onFlushStored` hook fire only for
   * chunks that actually persisted (matching the whole-batch semantics — an
   * alert never fires for a dropped chunk). A chunk's failure does not abort the
   * remaining chunks.
   */
  private async storeDrained(storage: StorageProvider, drained: Entry[]): Promise<void> {
    const batchSize = this.options.flushBatchSize;
    // Only chunk when a positive batch size actually bounds the drained count;
    // otherwise store the whole batch in one call (original behaviour).
    if (batchSize === undefined || batchSize <= 0 || batchSize >= drained.length) {
      await this.storeChunk(storage, drained);
      return;
    }
    for (let offset = 0; offset < drained.length; offset += batchSize) {
      await this.storeChunk(storage, drained.slice(offset, offset + batchSize));
    }
  }

  /**
   * Stores one chunk with bounded retry, then fires per-chunk rollups + the
   * flush hook only when it persisted. Shared by the chunked and whole-batch
   * paths so the post-store side effects are identical.
   */
  private async storeChunk(storage: StorageProvider, chunk: Entry[]): Promise<void> {
    const stored = await this.storeWithRetry(storage, chunk);
    if (stored) {
      await this.recordRollupsAfterStore(storage, chunk);
      await this.notifyFlushStored(chunk);
    }
  }

  /**
   * Persists `drained` with ONE bounded retry. On the first `store()` rejection
   * the Recorder waits `retryDelayMs` (default 1000ms) and retries exactly once;
   * a second failure drops the batch (`storeFailedDropped` + `store-failed`).
   *
   * Hard bounds preserved: this runs INSIDE the single in-flight `flushing`
   * promise, so no second failed batch can ever be queued concurrently, and the
   * ring keeps absorbing/evicting meanwhile — memory stays bounded. Returns
   * whether the batch was ultimately persisted.
   */
  private async storeWithRetry(storage: StorageProvider, drained: Entry[]): Promise<boolean> {
    try {
      await storage.store(drained);
      return true;
    } catch {
      // First failure: count the retry, back off, then try exactly once more.
      this.retriedFlushCount += 1;
      await this.delay(this.retryDelayMs);
      try {
        await storage.store(drained);
        return true;
      } catch {
        // Second failure: drop the batch (keep storeFailedDropped semantics).
        this.storeFailedDrops += drained.length;
        this.notifyDrop(drained.length, 'store-failed');
        return false;
      }
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * After a successful entry store, pre-aggregate the same batch into the
   * rollup layer when the storage also implements the {@link RollupStore} SPI.
   * The entries are already persisted, so a rollup failure must NOT be counted
   * as a store failure — it is swallowed independently. Never throws into the
   * flush chain.
   */
  private async recordRollupsAfterStore(storage: StorageProvider, drained: Entry[]): Promise<void> {
    if (!isRollupStore(storage)) return;
    try {
      await storage.recordRollups(aggregateDeltas(drained));
    } catch {
      // Rollups are best-effort; entries are already stored. Swallow.
    }
  }

  /**
   * Invoke the `onFlushStored` hook with the just-persisted batch. Awaited inside
   * the flush chain so the hook's work (e.g. per-flush alert evaluation) settles
   * before `flush()` resolves, but wrapped so a rejection/throw is swallowed — the
   * entries are already stored and a hook bug must never break the flush.
   */
  private async notifyFlushStored(drained: Entry[]): Promise<void> {
    if (this.options.onFlushStored === undefined) return;
    try {
      await this.options.onFlushStored(drained);
    } catch {
      // Best-effort observability hook; never break the flush.
    }
  }

  /**
   * Tail-sampling decision. Delegates to the shared resolver so the same logic
   * backs both the live path and the benchmark. The hot-path cost is shallow
   * field reads (type, tags, durationMs, content.statusCode/failed) — no walk.
   */
  private passesSampling(input: RecordInput): boolean {
    return passesSampling(this.options.sampling, input, this.random);
  }

  private enrich(input: RecordInput): Entry {
    const batch = this.options.context.current();
    // Resolve batchId FIRST: an out-of-batch entry's synthetic batch id uses
    // id-0, and the entry id uses id-1, keeping allocation order predictable.
    const batchId = batch?.id ?? this.options.idFactory();
    // Read the ambient trace context defensively: the provider contract says
    // current() must not throw, but a misbehaving provider should degrade to
    // null rather than drop the entry.
    let trace: TraceContext | null = null;
    try {
      trace = this.options.traceContext?.current() ?? null;
    } catch {
      trace = null;
    }
    // Bounded, synchronous redaction. The sync detach is load-bearing — it
    // snapshots the (possibly fat, possibly live-ORM-graph) content into a plain,
    // reference-free, size-capped clone at record() time (see spec §A.1). Track
    // when a bound clipped content so /health can surface fat-capture pressure.
    const redacted = redactBoundedWith(input.content, this.options.redact, this.redactSpec);
    if (redacted.truncated) {
      this.truncatedEntryCount += 1;
    }
    // Soft-detected nestjs-context enrichment (SECONDARY to OTel). Read once,
    // defensively: a misbehaving accessor degrades to no enrichment, never throws.
    const ctx = this.readContextEnrichment();
    // traceId precedence: OTel wins. The context traceId is only a FALLBACK when
    // the OTel provider did not yield one — never clobber an OTel trace id.
    const traceId = trace?.traceId ?? ctx.traceId;
    const base: Entry = {
      id: this.options.idFactory(),
      batchId,
      type: input.type,
      familyHash: input.familyHash ?? null,
      content: redacted.value,
      // Prepend the context user/tenant tags before taggers run so taggers and
      // the host `filter` can see them; runTaggers de-dupes order-preservingly.
      tags: ctx.tags.length > 0 ? [...ctx.tags, ...(input.tags ?? [])] : (input.tags ?? []),
      sequence: this.options.context.nextSequence(),
      durationMs: input.durationMs ?? null,
      origin: batch?.origin ?? 'manual',
      instanceId: this.options.instanceId,
      traceId,
      spanId: trace?.spanId ?? null,
      createdAt: input.startedAt ?? new Date(this.now()),
    };
    // Swap in the tagger-enriched tags IN PLACE rather than cloning the whole
    // Entry just to replace one field. runTaggers reads base.tags (the original
    // input/context tags) and other already-set fields; the call evaluates fully
    // before the assignment, so reading base here is safe and behaviour matches
    // the previous `{ ...base, tags }` exactly.
    base.tags = runTaggers(base, this.options.taggers);
    return base;
  }

  /**
   * Reads the optional, soft-detected {@link ContextAccessor} once. Returns the
   * context fallback `traceId` (or `null`) and any `user:`/`tenant:` tags. Every
   * accessor call is wrapped so a misbehaving accessor degrades to empty
   * enrichment and can never throw into `record()` (mirrors the OTel read).
   */
  private readContextEnrichment(): { traceId: string | null; tags: string[] } {
    const accessor = this.options.contextAccessor;
    if (accessor === undefined) {
      return { traceId: null, tags: [] };
    }
    const tags: string[] = [];
    let traceId: string | null = null;
    try {
      const ctxTraceId = accessor.traceId();
      if (typeof ctxTraceId === 'string' && ctxTraceId.length > 0) {
        traceId = ctxTraceId;
      }
    } catch {
      // Degrade silently — context is a best-effort secondary source.
    }
    try {
      const user = accessor.userRef();
      if (user !== undefined && user.id !== undefined && user.id !== null) {
        const id = String(user.id);
        if (id.length > 0) {
          tags.push(`user:${user.type}#${id}`);
        }
      }
    } catch {
      // Degrade silently.
    }
    try {
      const tenantId = accessor.tenantId();
      if (typeof tenantId === 'string' && tenantId.length > 0) {
        tags.push(`tenant:${tenantId}`);
      }
    } catch {
      // Degrade silently.
    }
    return { traceId, tags };
  }

  /**
   * O(1) ring-buffer push. On overflow the oldest entry is evicted so that
   * recent activity is always preserved.
   */
  private push(entry: Entry): void {
    const capacity = this.options.bufferSize;
    if (this.count >= capacity) {
      // Evict oldest (at head) to make room.
      this.head = (this.head + 1) % capacity;
      this.overflowDrops += 1;
      this.notifyDrop(1, 'overflow');
    } else {
      this.count += 1;
    }
    // Tail index: head + (count-1) wraps around the ring.
    const tail = (this.head + this.count - 1) % capacity;
    this.ring[tail] = entry;
    // Cheap self-metrics: count the buffered record and track the high-water mark.
    this.recordedCount += 1;
    if (this.count > this.highWaterCount) {
      this.highWaterCount = this.count;
    }
  }

  /**
   * Drains all entries from the ring in oldest→newest order and resets it.
   * Returns a plain array for hand-off to storage.
   */
  private drain(): Entry[] {
    const capacity = this.options.bufferSize;
    const result: Entry[] = new Array<Entry>(this.count);
    for (let i = 0; i < this.count; i++) {
      const slot = (this.head + i) % capacity;
      // The slot is always defined here because we only read within count.
      result[i] = this.ring[slot] as Entry;
      // Null the drained slot so the ring no longer retains the (potentially
      // fat) entry after a flush. Without this, stale fat entries linger in
      // unread slots up to capacity until overwritten — a slow memory floor
      // that fed the incident's working set. Per-slot here is the cheapest
      // correct clear (only the slots we actually held).
      this.ring[slot] = undefined;
    }
    // Reset ring state.
    this.head = 0;
    this.count = 0;
    return result;
  }

  /**
   * Records off-path flush self-metrics. Only invoked from `flush()`, which has
   * already guaranteed `drainedCount >= 1`, so every call here counts a flush
   * that drained at least one entry.
   */
  private recordFlushMetrics(drainedCount: number, durationMs: number): void {
    this.flushCount += 1;
    this.flushedEntriesCount += drainedCount;
    this.lastFlushDurationMs = durationMs;
    this.totalFlushDurationMs += durationMs;
    if (this.maxFlushDurationMs === null || durationMs > this.maxFlushDurationMs) {
      this.maxFlushDurationMs = durationMs;
    }
  }

  /** Calls `onDrop` inside a try/catch so a faulty hook cannot escape. */
  private notifyDrop(count: number, reason: DropReason): void {
    if (this.options.onDrop === undefined) {
      return;
    }
    try {
      this.options.onDrop(count, reason);
    } catch {
      // A faulty hook must never break the Recorder.
    }
  }
}
