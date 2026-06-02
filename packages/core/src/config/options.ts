// packages/core/src/config/options.ts
import type { Entry } from '../entry/entry.js';
import type { RedactOptions } from '../redaction/redact.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import type { Tagger } from '../tagging/tagger.js';

export type Duration = number | string;

export interface PruneOptions {
  after: Duration;
  keepLast?: number;
  intervalMs?: number;
}

export interface RecorderTuning {
  bufferSize?: number;
  flushIntervalMs?: number;
  flushBatchSize?: number;
}

/** Author-facing options. NestJS-specific fields (watchers, authorizer, path) are
 *  layered on in the Nest integration package; this shape is the agnostic subset. */
export interface TelescopeCoreOptions {
  enabled?: boolean;
  storage?: StorageProvider;
  redact?: RedactOptions;
  sampling?: number | Record<string, number>;
  recorder?: RecorderTuning;
  prune?: PruneOptions;
  taggers?: Tagger[];
  instanceId?: string;
  filter?: (entry: Entry) => boolean;
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
}
