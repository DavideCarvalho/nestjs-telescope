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
}

/** Author-facing options. NestJS-specific fields (watchers, authorizer, path) are
 *  layered on in the Nest integration package; this shape is the agnostic subset. */
export interface TelescopeCoreOptions {
  enabled?: boolean;
  storage?: StorageProvider;
  redact?: RedactOptions;
  /**
   * Per-entry-type keep rate (0–1). A bare number is normalised to `{ default: <rate> }`,
   * which applies to every entry type that lacks a specific rate override.
   */
  sampling?: number | Record<string, number>;
  recorder?: RecorderTuning;
  prune?: PruneOptions;
  taggers?: Tagger[];
  instanceId?: string;
  filter?: (entry: Entry) => boolean;
  /** Optional ambient trace-context source (e.g. OtelTraceContextProvider). */
  traceContext?: TraceContextProvider;
  /** UI trace-link URL template with {traceId}/{spanId} placeholders. */
  traceLink?: string;
}

export interface ResolvedCoreConfig {
  enabled: boolean;
  redact: RedactOptions;
  sampling: Record<string, number>;
  recorder: Required<RecorderTuning>;
  prune?: { afterMs: number; keepLast?: number; intervalMs: number };
  taggers: Tagger[];
  instanceId: string;
  filter?: (entry: Entry) => boolean;
  traceContext?: TraceContextProvider;
  traceLink?: string;
}
