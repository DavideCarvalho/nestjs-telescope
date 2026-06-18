// packages/core/src/config/options.ts
import type { Entry } from '../entry/entry.js';
import type { ProfilingOptions, ResolvedProfilingConfig } from '../profiling/profiling-config.js';
import type { RedactOptions } from '../redaction/redact.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import type { Tagger } from '../tagging/tagger.js';
import type { TraceContextProvider } from '../trace/trace-context-provider.js';

export type Duration = number | string;

/**
 * Export-before-prune: hand doomed entries to a host-owned `sink` (S3, a data
 * lake, cold storage…) BEFORE the pruner deletes them, so retention shrinks the
 * live store without losing the data that matters.
 *
 * The contract is "archive THEN delete, per type, per cycle":
 *  - Only entry types listed in `types` are archived; every other type prunes
 *    normally and is unaffected by archiving.
 *  - For each archived type the pruner fetches entries older than THAT type's
 *    cutoff (its `perType` override, else the global `after`) and streams them to
 *    `sink` in `batchSize` chunks. The type's entries are deleted ONLY after the
 *    sink resolves for all of its batches.
 *  - If the sink throws/rejects, that type is NOT deleted this cycle (the doomed
 *    entries survive to be retried next cycle); the error is logged (rate-limited
 *    to once per cycle) and the rest of the prune cycle continues. A failing sink
 *    can never crash the host or stop the pruner.
 *  - Work per type per cycle is bounded (see {@link ArchiveOptions.maxBatchesPerCycle});
 *    any remainder is picked up on the next tick.
 */
export interface ArchiveOptions {
  /** Entry types to archive before pruning. Types not listed prune normally. */
  types: string[];
  /**
   * Receives a batch of doomed entries. MUST resolve only once the batch is
   * durably stored; a rejection makes the pruner keep those entries (retry next
   * cycle). Runs OUTSIDE the host request path — it may do slow network I/O.
   */
  sink: (entries: Entry[]) => Promise<void>;
  /** Entries handed to `sink` per call. Default 500. */
  batchSize?: number;
  /**
   * Hard cap on the number of `sink` batches per archived type per cycle, so a
   * large backlog can never make one tick do unbounded work (which would stall
   * the unref'd timer and pile up memory). Leftover is archived next cycle.
   * Default 10.
   */
  maxBatchesPerCycle?: number;
}

export interface PruneOptions {
  after: Duration;
  keepLast?: number;
  intervalMs?: number;
  /**
   * Per-entry-type retention overrides. Each key is an entry type (e.g.
   * `'exception'`, `'request'`) and the value is a {@link Duration} cutoff for
   * THAT type only. Types absent from this map fall back to the global `after`,
   * so omitting `perType` reproduces the exact pre-existing global behaviour.
   *
   * Each cutoff is validated at module init the same way `after` is — an
   * unparseable duration is a boot error, not a silent runtime skip.
   *
   * @example keep exceptions for a week, everything else for the global default
   * ```ts
   * prune: { after: '5m', intervalMs: 60_000, perType: { exception: '7d' } }
   * ```
   */
  perType?: Record<string, Duration>;
}

export interface RecorderTuning {
  bufferSize?: number;
  /** Consumed by the NestJS integration layer's flush scheduler; the core Recorder itself does not start a timer. */
  flushIntervalMs?: number;
  /** Consumed by the NestJS integration layer's flush scheduler; the core Recorder itself does not start a timer. */
  flushBatchSize?: number;
  /**
   * Backoff before the single bounded retry of a failed `storage.store()` batch.
   * On the first rejection the Recorder waits this long, then retries ONCE; a
   * second failure drops the batch (`storeFailedDropped`). Default `1000`ms.
   */
  retryDelayMs?: number;
}

/**
 * Tail-sampling rule for a single entry type. Keeps `rate` of the noise but
 * always retains the entries that matter — errors and slow ones.
 */
export interface SamplingRule {
  /** Base keep-rate 0–1 applied to ordinary entries of this type. */
  rate: number;
  /** When true, always keep entries that look like errors (see {@link isErrorEntry}). */
  keepErrors?: boolean;
  /** When set, always keep entries whose `durationMs` is at least this value. */
  keepSlowMs?: number;
}

/**
 * Per-type sampling configuration. Each type maps to either a bare keep-rate
 * (uniform down-sampling, unchanged behaviour) or a {@link SamplingRule} object
 * (tail-sampling: keep a fraction but always retain errors / slow entries).
 */
export type SamplingConfig = Record<string, number | SamplingRule>;

/** Author-facing options. NestJS-specific fields (watchers, authorizer, path) are
 *  layered on in the Nest integration package; this shape is the agnostic subset. */
export interface TelescopeCoreOptions {
  enabled?: boolean;
  storage?: StorageProvider;
  redact?: RedactOptions;
  /**
   * Per-entry-type keep rate (0–1). A bare number is normalised to `{ default: <rate> }`,
   * which applies to every entry type that lacks a specific rate override.
   *
   * A per-type value may also be a {@link SamplingRule} object to tail-sample:
   * keep `rate` of the noise but always retain errors (`keepErrors`) and slow
   * entries (`keepSlowMs`). Bare-number entries keep their exact prior behaviour.
   */
  sampling?: number | SamplingConfig;
  recorder?: RecorderTuning;
  prune?: PruneOptions;
  /**
   * Export captured entries to a host-owned sink right before the pruner deletes
   * them. See {@link ArchiveOptions}. Only meaningful alongside `prune`: with no
   * pruning nothing is ever doomed, so nothing is archived.
   */
  archive?: ArchiveOptions;
  taggers?: Tagger[];
  instanceId?: string;
  filter?: (entry: Entry) => boolean;
  /**
   * On-demand CPU flamegraph profiling. STRICTLY opt-in and OFF by default; when
   * absent or `{ enabled: false }` the profiler is never constructed, the Node
   * `inspector` module is never loaded, and the request path is untouched beyond
   * a single boolean check. See {@link ProfilingOptions}.
   */
  profiling?: ProfilingOptions;
  /** Optional ambient trace-context source (e.g. OtelTraceContextProvider). */
  traceContext?: TraceContextProvider;
  /** UI trace-link URL template with {traceId}/{spanId} placeholders. */
  traceLink?: string;
  /**
   * Mount path for the dashboard + API (no leading/trailing slash needed).
   * Defaults to `'telescope'` — when unset everything behaves exactly as before
   * (dashboard at `/telescope`, API at `/telescope/api`). Set e.g.
   * `'observability'` for `/observability` + `/observability/api`.
   */
  path?: string;
}

export interface ResolvedCoreConfig {
  enabled: boolean;
  /** Normalized mount segment (no leading/trailing slash). Default `'telescope'`. */
  path: string;
  redact: RedactOptions;
  sampling: SamplingConfig;
  recorder: Required<RecorderTuning>;
  prune?: {
    afterMs: number;
    keepLast?: number;
    intervalMs: number;
    /**
     * Resolved per-type cutoffs in ms, keyed by entry type. Empty when the host
     * supplied no `perType` overrides (the common case), in which case the
     * pruner runs a single global cycle exactly as before.
     */
    perTypeMs: Record<string, number>;
  };
  /**
   * Resolved archive config (with `batchSize`/`maxBatchesPerCycle` defaulted),
   * or absent when the host configured no `archive`.
   */
  archive?: {
    types: Set<string>;
    sink: (entries: Entry[]) => Promise<void>;
    batchSize: number;
    maxBatchesPerCycle: number;
  };
  taggers: Tagger[];
  instanceId: string;
  filter?: (entry: Entry) => boolean;
  /** Fully-defaulted profiling config. Always present; `enabled: false` by default. */
  profiling: ResolvedProfilingConfig;
  traceContext?: TraceContextProvider;
  traceLink?: string;
}
