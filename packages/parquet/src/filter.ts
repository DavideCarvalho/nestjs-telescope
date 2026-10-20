import type { Entry, EntryQuery } from '@dudousxd/nestjs-telescope';
import { decodeCursor } from '@dudousxd/nestjs-telescope';

/** An `EntryQuery` resolved for the cold tier: bounds as epoch-ms, ids as a set, search lowercased. */
export interface ColdFilter {
  type?: string;
  ids?: ReadonlySet<string>;
  batchId?: string;
  traceId?: string;
  familyHash?: string;
  tag?: string;
  /** Lowercased. */
  search?: string;
  /** Exclusive. */
  beforeMs?: number;
  /** Exclusive. */
  afterMs?: number;
  /** Rows strictly older than this `(createdAt, id)` position. */
  cursor?: { createdAt: number; id: string };
  omitContent: boolean;
}

export function toColdFilter(query: EntryQuery): ColdFilter {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  return {
    ...(query.type !== undefined ? { type: query.type } : {}),
    ...(query.ids !== undefined ? { ids: new Set(query.ids) } : {}),
    ...(query.batchId !== undefined ? { batchId: query.batchId } : {}),
    ...(query.traceId !== undefined ? { traceId: query.traceId } : {}),
    ...(query.familyHash !== undefined ? { familyHash: query.familyHash } : {}),
    ...(query.tag !== undefined ? { tag: query.tag } : {}),
    ...(query.search !== undefined ? { search: query.search.toLowerCase() } : {}),
    ...(query.before !== undefined ? { beforeMs: query.before.getTime() } : {}),
    ...(query.after !== undefined ? { afterMs: query.after.getTime() } : {}),
    ...(cursor !== null ? { cursor } : {}),
    omitContent: query.omitContent === true,
  };
}

/** Newest `createdAt` a matching row can have, inclusive. */
export function upperBound(filter: ColdFilter): number {
  let upper = Number.POSITIVE_INFINITY;
  if (filter.beforeMs !== undefined) upper = Math.min(upper, filter.beforeMs - 1);
  if (filter.cursor !== undefined) upper = Math.min(upper, filter.cursor.createdAt);
  return upper;
}

/** Oldest `createdAt` a matching row can have, inclusive. */
export function lowerBound(filter: ColdFilter): number {
  return filter.afterMs !== undefined ? filter.afterMs + 1 : Number.NEGATIVE_INFINITY;
}

/**
 * The full predicate, applied to every decoded row. Engines push what they can down to the file
 * (statistics, bloom filters, SQL) and the rest is decided here, so both engines agree exactly.
 */
export function matches(entry: Entry, filter: ColdFilter, content: string | undefined): boolean {
  if (filter.ids !== undefined && !filter.ids.has(entry.id)) return false;
  if (filter.type !== undefined && entry.type !== filter.type) return false;
  if (filter.batchId !== undefined && entry.batchId !== filter.batchId) return false;
  if (filter.traceId !== undefined && entry.traceId !== filter.traceId) return false;
  if (filter.familyHash !== undefined && entry.familyHash !== filter.familyHash) return false;
  if (filter.tag !== undefined && !entry.tags.includes(filter.tag)) return false;
  const at = entry.createdAt.getTime();
  if (filter.beforeMs !== undefined && at >= filter.beforeMs) return false;
  if (filter.afterMs !== undefined && at <= filter.afterMs) return false;
  if (filter.cursor !== undefined) {
    const { createdAt, id } = filter.cursor;
    if (at > createdAt || (at === createdAt && entry.id >= id)) return false;
  }
  if (filter.search !== undefined) {
    if (content === undefined || !content.toLowerCase().includes(filter.search)) return false;
  }
  return true;
}
