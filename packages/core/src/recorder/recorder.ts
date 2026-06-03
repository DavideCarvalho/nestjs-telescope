import type { TelescopeContext } from '../context/telescope-context.js';
// packages/core/src/recorder/recorder.ts
import type { Entry, RecordInput } from '../entry/entry.js';
import type { RedactOptions } from '../redaction/redact.js';
import { redact } from '../redaction/redact.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import type { Tagger } from '../tagging/tagger.js';
import { runTaggers } from '../tagging/tagger.js';
import type {
  TraceContext,
  TraceContextProvider,
} from '../trace/trace-context-provider.js';

export type DropReason = 'overflow' | 'store-failed' | 'record-error';

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

  // ── Core API ───────────────────────────────────────────────────────────────

  /** Synchronous, O(1), never throws into the caller. */
  record(input: RecordInput): void {
    try {
      if (!this.passesSampling(input.type)) {
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

    this.flushing = this.options.storage
      .store(drained)
      .catch(() => {
        this.storeFailedDrops += drained.length;
        this.notifyDrop(drained.length, 'store-failed');
      })
      .finally(() => {
        this.flushing = null;
      });

    return this.flushing;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

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
    const base: Entry = {
      id: this.options.idFactory(),
      batchId,
      type: input.type,
      familyHash: input.familyHash ?? null,
      content: redact(input.content, this.options.redact),
      tags: input.tags ?? [],
      sequence: this.options.context.nextSequence(),
      durationMs: input.durationMs ?? null,
      origin: batch?.origin ?? 'manual',
      instanceId: this.options.instanceId,
      traceId: trace?.traceId ?? null,
      spanId: trace?.spanId ?? null,
      createdAt: input.startedAt ?? new Date(this.now()),
    };
    return { ...base, tags: runTaggers(base, this.options.taggers) };
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
