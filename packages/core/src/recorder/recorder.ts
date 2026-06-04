import type { TelescopeContext } from '../context/telescope-context.js';
// packages/core/src/recorder/recorder.ts
import type { Entry, RecordInput } from '../entry/entry.js';
import type { RedactOptions } from '../redaction/redact.js';
import { redact } from '../redaction/redact.js';
import { aggregateDeltas } from '../rollup/aggregate-deltas.js';
import { isRollupStore } from '../rollup/rollup-store.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import type { Tagger } from '../tagging/tagger.js';
import { runTaggers } from '../tagging/tagger.js';
import type { TraceContext, TraceContextProvider } from '../trace/trace-context-provider.js';

export type DropReason = 'overflow' | 'store-failed' | 'record-error';

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
}

export interface RecorderOptions {
  storage: StorageProvider;
  context: TelescopeContext;
  instanceId: string;
  taggers: Tagger[];
  redact: RedactOptions;
  /** Per-type keep-rate 0..1. Missing type ⇒ keep (rate 1). */
  sampling: Record<string, number>;
  bufferSize: number;
  now?: () => number;
  random?: () => number;
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
}

/**
 * Buffers {@link Entry} objects in a fixed-capacity O(1) ring buffer and
 * periodically flushes them to a {@link StorageProvider}.
 *
 * **Overflow policy** — overflow drops the OLDEST buffered entry (so under
 * sustained overload a batch may be stored without its earliest entries);
 * recent activity is preferred.
 *
 * **Storage failures** — when `store()` rejects, the drained batch is dropped
 * with no retry by design (fail-open, never grow). Drops are surfaced via the
 * `onDrop` callback and the `storeFailedDropped` / `droppedCount` counters.
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
  private lastFlushDurationMs: number | null = null;
  private maxFlushDurationMs: number | null = null;
  private totalFlushDurationMs = 0;

  // ── Concurrency guard ─────────────────────────────────────────────────────
  private flushing: Promise<void> | null = null;

  // ── Determinism seams ─────────────────────────────────────────────────────
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly options: RecorderOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
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
      lastFlushMs: this.lastFlushDurationMs,
      maxFlushMs: this.maxFlushDurationMs,
      totalFlushMs: this.totalFlushDurationMs,
      overflowDropped: this.overflowDrops,
      storeFailedDropped: this.storeFailedDrops,
      droppedCount: this.droppedCount,
    };
  }

  /**
   * On-demand micro-benchmark of the synchronous capture path (sampling check +
   * cheap enrich) on a representative input, WITHOUT enqueuing into the ring or
   * touching storage. Redaction, tagging and filtering now happen off the host
   * path in `flush()`, so they are intentionally NOT measured here — this figure
   * reflects the true per-capture cost paid by the host app. Returns the mean
   * nanoseconds per call. Lives here so the "cost per capture" figure is honest
   * yet never instruments live records.
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
   * Runs the same sampling + cheap-enrich logic as `record()` but discards the
   * entry instead of buffering it. Mirrors the real host-path cost: redaction,
   * tagging and filtering are deferred to `flush()` and so are NOT exercised
   * here. Used only by the benchmark.
   */
  private measureCaptureOnce(input: RecordInput): void {
    if (!this.passesSampling(input.type)) {
      return;
    }
    this.enrichCheap(input);
  }

  // ── Core API ───────────────────────────────────────────────────────────────

  /**
   * Synchronous, O(1), never throws into the caller. Does ONLY cheap work that
   * must read the current async context: sampling, async-context/identity
   * capture (batch id, sequence, trace ids), then buffers the entry with its
   * RAW, un-redacted content and un-tagged tags. The heavy per-entry work —
   * redaction, tagging and the user filter — is deferred to `flush()`, off the
   * host app's critical path. Only `flush()`/`drain()` read buffered entries, so
   * holding raw content in the ring is safe.
   */
  record(input: RecordInput): void {
    try {
      if (!this.passesSampling(input.type)) {
        return;
      }
      this.push(this.enrichCheap(input));
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

    // Finalize off the host path: redact + tag each entry, then apply the user
    // filter. Entries the filter rejects are intentionally excluded from the
    // stored batch (NOT counted as a drop, matching the old in-record() filter
    // semantics). This is the heavy per-entry work moved off `record()`.
    const finalized = this.finalizeAndFilter(drained);

    // Off the host path: timing the flush here is safe. Use the `now()` seam so
    // tests stay deterministic, consistent with how the rest of the Recorder
    // reads wall time.
    const flushStartedAt = this.now();

    const storage = this.options.storage;
    this.flushing = storage
      .store(finalized)
      .then(() => this.recordRollupsAfterStore(storage, finalized))
      .catch(() => {
        this.storeFailedDrops += finalized.length;
        this.notifyDrop(finalized.length, 'store-failed');
      })
      .finally(() => {
        this.recordFlushMetrics(finalized.length, this.now() - flushStartedAt);
        this.flushing = null;
      });

    return this.flushing;
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
   * Finalizes (redact + tag) every drained entry and then applies the optional
   * user filter. Runs entirely off the host path inside `flush()`. Filter
   * rejections are intentional exclusions (not drops, no counter touched),
   * mirroring the semantics of the old in-`record()` filter.
   */
  private finalizeAndFilter(drained: Entry[]): Entry[] {
    const result: Entry[] = [];
    const filter = this.options.filter;
    for (const entry of drained) {
      const finalized = this.finalize(entry);
      if (filter !== undefined && !filter(finalized)) {
        continue;
      }
      result.push(finalized);
    }
    return result;
  }

  private passesSampling(type: string): boolean {
    const rate = this.options.sampling[type] ?? this.options.sampling.default;
    if (rate === undefined || rate >= 1) {
      return true;
    }
    if (rate <= 0) {
      return false;
    }
    return this.random() < rate;
  }

  /**
   * Cheap, hot-path enrichment. Captures everything that MUST be read in the
   * caller's synchronous async-context — batch id, monotonic sequence, and the
   * active trace ids — plus the passthrough identity fields. Crucially it does
   * NOT redact content or run taggers: it stashes the RAW `input.content` and
   * the input's own tags. The heavy work is finalized later in `finalize()`
   * from `flush()`, off the host path.
   */
  private enrichCheap(input: RecordInput): Entry {
    const batch = this.options.context.current();
    // Resolve batchId FIRST: an out-of-batch entry's synthetic batch id uses
    // id-0, and the entry id uses id-1, keeping allocation order predictable.
    const batchId = batch?.id ?? this.options.idFactory();
    // Read the ambient trace context defensively: the provider contract says
    // current() must not throw, but a misbehaving provider should degrade to
    // null rather than drop the entry. This MUST happen at record() time — the
    // active span is only correct synchronously, not later during flush().
    let trace: TraceContext | null = null;
    try {
      trace = this.options.traceContext?.current() ?? null;
    } catch {
      trace = null;
    }
    return {
      id: this.options.idFactory(),
      batchId,
      type: input.type,
      familyHash: input.familyHash ?? null,
      // RAW content — redaction is deferred to finalize() during flush().
      content: input.content,
      // RAW tags — taggers are deferred to finalize() during flush().
      tags: input.tags ?? [],
      sequence: this.options.context.nextSequence(),
      durationMs: input.durationMs ?? null,
      origin: batch?.origin ?? 'manual',
      instanceId: this.options.instanceId,
      traceId: trace?.traceId ?? null,
      spanId: trace?.spanId ?? null,
      createdAt: input.startedAt ?? new Date(this.now()),
    };
  }

  /**
   * Finalizes a cheaply-enriched entry off the host path (called from
   * `flush()`). Applies, in the SAME order the old synchronous `enrich()` did:
   * (a) redact the raw content, then (b) run taggers over the entry whose
   * content is already redacted — `statusTagger` reads `content.statusCode`, so
   * redaction MUST precede tagging to keep behaviour identical.
   */
  private finalize(entry: Entry): Entry {
    const redacted: Entry = { ...entry, content: redact(entry.content, this.options.redact) };
    return { ...redacted, tags: runTaggers(redacted, this.options.taggers) };
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
