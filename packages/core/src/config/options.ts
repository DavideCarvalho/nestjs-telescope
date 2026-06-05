// packages/core/src/config/options.ts
import type { Entry } from '../entry/entry.js';
import type { RedactOptions } from '../redaction/redact.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import type { Tagger } from '../tagging/tagger.js';
import type { TraceContextProvider } from '../trace/trace-context-provider.js';

export type Duration = number | string;

export interface PruneOptions {
  after: Duration;
  keepLast?: number;
  intervalMs?: number;
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
  taggers?: Tagger[];
  instanceId?: string;
  filter?: (entry: Entry) => boolean;
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
  prune?: { afterMs: number; keepLast?: number; intervalMs: number };
  taggers: Tagger[];
  instanceId: string;
  filter?: (entry: Entry) => boolean;
  traceContext?: TraceContextProvider;
  traceLink?: string;
}
