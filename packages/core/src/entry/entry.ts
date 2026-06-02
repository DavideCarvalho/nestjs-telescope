// packages/core/src/entry/entry.ts

export const EntryType = {
  Request: 'request',
  Query: 'query',
  Job: 'job',
  Exception: 'exception',
  Mail: 'mail',
  Cache: 'cache',
  HttpClient: 'http_client',
} as const;

export type BuiltinEntryType = (typeof EntryType)[keyof typeof EntryType];

const BATCH_ORIGINS = ['http', 'queue', 'schedule', 'cli', 'manual'] as const;
export type BatchOrigin = (typeof BATCH_ORIGINS)[number];

export function isBatchOrigin(value: unknown): value is BatchOrigin {
  return typeof value === 'string' && (BATCH_ORIGINS as readonly string[]).includes(value);
}

/** A captured, persisted record. `content` is type-specific (see content.ts). */
export interface Entry<TContent = unknown> {
  id: string;
  batchId: string;
  type: string;
  familyHash: string | null;
  content: TContent;
  tags: string[];
  sequence: number;
  durationMs: number | null;
  origin: BatchOrigin;
  instanceId: string;
  createdAt: Date;
}

/** What a watcher hands to the Recorder. Everything else is filled in by enrichment. */
export interface RecordInput<TContent = unknown> {
  type: string;
  content: TContent;
  familyHash?: string | null;
  tags?: string[];
  durationMs?: number | null;
  startedAt?: Date;
}
