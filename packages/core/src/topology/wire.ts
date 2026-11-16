// packages/core/src/topology/wire.ts
//
// What a tenant sends to its control plane. One batch of entries, already redacted, sampled and
// tagged by the tenant's own recorder. Every transport carries the same batch.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type Entry, isBatchOrigin } from '../entry/entry.js';

/** The wire version. A control plane refuses a batch of a version it does not know. */
export const INGEST_WIRE_VERSION = 1;

/** The most entries one batch may carry. */
export const MAX_INGEST_ENTRIES = 1_000;

/**
 * How far ahead of the control plane's clock an entry's `createdAt` may be. A later time becomes
 * the arrival time, so a sender cannot push its entries ahead of everyone else's.
 */
export const MAX_FUTURE_SKEW_MS = 5 * 60_000;

/** The tag every ingested entry gets: `app:<partition>`. */
export const APP_TAG_PREFIX = 'app';

/** An entry on the wire: an {@link Entry} whose `createdAt` is an ISO string. */
export interface WireEntry extends Omit<Entry, 'createdAt'> {
  createdAt: string;
}

/** One batch of entries from a tenant. `id` is stable across retries, so a resend is deduped. */
export interface IngestBatch {
  v: typeof INGEST_WIRE_VERSION;
  id: string;
  /** When the tenant sent it (its own clock), for lag reporting. */
  sentAt: string;
  entries: WireEntry[];
  /**
   * The sender's latest heartbeat (an `InstanceHeartbeat`), riding the batch so it travels over
   * every transport. Additive: a control plane that predates the fleet ignores it.
   */
  heartbeat?: unknown;
}

/**
 * A batch with its credentials, for a broker transport where no HTTP header carries the token.
 * `partition` is the sender's claim, advisory only: the control plane takes the app from the token.
 */
export interface IngestEnvelope extends IngestBatch {
  token: string;
  partition: string;
}

/** An entry or batch id: 1–255 printable ASCII characters. */
const ID = /^[\x21-\x7e]{1,255}$/;
const shortString = z.string().max(255);

const wireEntrySchema = z.object({
  id: z.string(),
  batchId: shortString,
  type: z.string().min(1).max(64),
  familyHash: shortString.nullable().optional(),
  content: z.unknown(),
  tags: z.array(shortString).max(100),
  sequence: z.number().finite().optional(),
  durationMs: z.number().finite().nullable().optional(),
  origin: z.string().optional(),
  instanceId: shortString.optional(),
  traceId: shortString.nullable().optional(),
  spanId: shortString.nullable().optional(),
  createdAt: z.string().max(64),
});

const batchSchema = z.object({
  v: z.literal(INGEST_WIRE_VERSION),
  id: z.string().regex(ID),
  sentAt: z.string().max(64),
  entries: z.array(wireEntrySchema).max(MAX_INGEST_ENTRIES),
  // Validated by the fleet (`normalizeHeartbeat`); an older control plane ignores it.
  heartbeat: z.unknown().optional(),
});

/** A wire entry with its `createdAt` as a string. */
export function toWireEntry(entry: Entry): WireEntry {
  return { ...entry, createdAt: entry.createdAt.toISOString() };
}

/** Builds a batch with a fresh id. */
export function ingestBatch(
  entries: Entry[],
  now: Date = new Date(),
  heartbeat?: unknown,
): IngestBatch {
  return {
    v: INGEST_WIRE_VERSION,
    id: randomUUID(),
    sentAt: now.toISOString(),
    entries: entries.map(toWireEntry),
    ...(heartbeat !== undefined ? { heartbeat } : {}),
  };
}

/** The validated batch, or why it was refused. A refused batch is never retried. */
export type ParsedBatch = { ok: true; batch: IngestBatch } | { ok: false; reason: string };

/** Validates the shape and bounds of a batch from an untrusted sender. */
export function parseIngestBatch(body: unknown): ParsedBatch {
  const parsed = batchSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      reason: `invalid batch${issue ? ` at ${issue.path.join('.') || '(root)'}: ${issue.message}` : ''}`,
    };
  }
  return { ok: true, batch: parsed.data as IngestBatch };
}

/**
 * The `createdAt` the control plane keeps: the sender's time, unless it is invalid, negative, or
 * more than {@link MAX_FUTURE_SKEW_MS} ahead of `now` (then `now`).
 */
export function resolveCreatedAt(value: unknown, now: number): Date {
  const time =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'string'
        ? Date.parse(value)
        : Number.NaN;
  if (!Number.isFinite(time) || time < 0 || time > now + MAX_FUTURE_SKEW_MS) return new Date(now);
  return new Date(time);
}

/** Whether `id` is a usable entry id (1–255 printable ASCII characters). */
export function isEntryId(id: unknown): id is string {
  return typeof id === 'string' && ID.test(id);
}

/**
 * The entry the control plane stores for a wire entry from `partition`: tagged `app:<partition>`
 * (an `app:` tag the sender set itself is dropped, so it cannot claim another app), with its own
 * time kept within {@link MAX_FUTURE_SKEW_MS}. `null` for an entry whose id is unusable.
 */
export function fromWireEntry(wire: WireEntry, partition: string, now: number): Entry | null {
  if (!isEntryId(wire.id)) return null;
  const appPrefix = `${APP_TAG_PREFIX}:`;
  const tags = [
    ...new Set(wire.tags.filter((tag) => !tag.startsWith(appPrefix))),
    `${appPrefix}${partition}`,
  ];
  return {
    id: wire.id,
    batchId: wire.batchId,
    type: wire.type,
    familyHash: wire.familyHash ?? null,
    content: wire.content,
    tags,
    sequence: wire.sequence ?? 0,
    durationMs: wire.durationMs ?? null,
    origin: isBatchOrigin(wire.origin) ? wire.origin : 'manual',
    instanceId: wire.instanceId ?? partition,
    traceId: wire.traceId ?? null,
    spanId: wire.spanId ?? null,
    createdAt: resolveCreatedAt(wire.createdAt, now),
  };
}
