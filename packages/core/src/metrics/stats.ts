// packages/core/src/metrics/stats.ts
import type {
  CacheContent,
  ExceptionContent,
  QueryContent,
  RequestContent,
} from '../entry/content.js';
import { type Entry, EntryType } from '../entry/entry.js';
import { type TimeseriesReport, bucketTimeseries } from './timeseries.js';

export interface LatencyStats {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  slow: number;
}

export interface FamilyLatency {
  familyHash: string;
  label: string;
  count: number;
  p50: number;
  p99: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  hitRatio: number;
  topKeys: { key: string; count: number }[];
}

export interface StatusBreakdown {
  '2xx': number;
  '3xx': number;
  '4xx': number;
  '5xx': number;
  other: number;
}

export interface ExceptionGroupStats {
  /** The family key — the entry's `familyHash` when present, else `${class}: ${message}`. */
  key: string;
  class: string;
  message: string;
  count: number;
  /** Most recent occurrence in the window. */
  lastAt: Date;
  /** Per-bucket occurrence counts, aligned to the report's `overTime` buckets. */
  overTime: number[];
}

export interface StatsResult {
  type: string;
  windowMs: number;
  total: number;
  /** Throughput over the window — reuses {@link bucketTimeseries}. */
  overTime: TimeseriesReport;
  /** Present for types whose entries carry a `durationMs`. */
  latency?: LatencyStats;
  /** Query only: top families by p99. */
  families?: FamilyLatency[];
  /** Cache only. */
  cache?: CacheStats;
  /** Request only. */
  status?: StatusBreakdown;
  /** Exception only: top groups by class+message, with count, last-seen, over-time. */
  exceptions?: ExceptionGroupStats[];
  /** Caller-supplied: whether the scan hit its cap. */
  truncated: boolean;
}

export interface SummarizeStatsInput {
  entries: Entry[];
  type: string;
  windowStart: Date;
  windowEnd: Date;
  windowMs: number;
  buckets: number;
  slowMs: number;
  truncated: boolean;
  topFamilies?: number;
  topKeys?: number;
  topExceptions?: number;
}

const DEFAULT_TOP_FAMILIES = 8;
const DEFAULT_TOP_KEYS = 8;
const DEFAULT_TOP_EXCEPTIONS = 8;
const MAX_FAMILY_LABEL_LENGTH = 60;

/** Nearest-rank percentile over a NON-EMPTY ascending array; 0 for empty.
 *  `q` in [0,1]; `idx = clamp(ceil(q*n)-1, 0, n-1)`. */
export function percentile(sortedAscending: number[], q: number): number {
  const n = sortedAscending.length;
  if (n === 0) return 0;
  const rawIndex = Math.ceil(q * n) - 1;
  const index = Math.min(n - 1, Math.max(0, rawIndex));
  const value = sortedAscending[index];
  return value ?? 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Only `sql` is required: real-world query content varies by ORM logger (e.g.
// the MikroORM logger emits `{ sql, bindings, took }` with no `slow`/`connection`),
// and the family label only needs the SQL text. Missing optional fields degrade
// gracefully rather than rejecting the whole content.
function asQueryContent(content: unknown): QueryContent | null {
  if (!isRecord(content)) return null;
  if (typeof content.sql !== 'string') return null;
  return {
    sql: content.sql,
    bindings: Array.isArray(content.bindings) ? content.bindings : [],
    connection: typeof content.connection === 'string' ? content.connection : null,
    slow: typeof content.slow === 'boolean' ? content.slow : false,
  };
}

function asCacheContent(content: unknown): CacheContent | null {
  if (!isRecord(content)) return null;
  if (content.operation !== 'get' && content.operation !== 'set') return null;
  if (typeof content.key !== 'string') return null;
  const hit = content.hit;
  if (hit !== true && hit !== false && hit !== null) return null;
  return { operation: content.operation, key: content.key, hit };
}

function asExceptionContent(content: unknown): Pick<ExceptionContent, 'class' | 'message'> | null {
  if (!isRecord(content)) return null;
  const className = typeof content.class === 'string' ? content.class : 'Error';
  const message = typeof content.message === 'string' ? content.message : '';
  return { class: className, message };
}

function asRequestContent(content: unknown): Pick<RequestContent, 'statusCode'> | null {
  if (!isRecord(content)) return null;
  const statusCode = content.statusCode;
  if (typeof statusCode === 'number') return { statusCode };
  if (statusCode === null) return { statusCode: null };
  return null;
}

function computeLatency(entries: Entry[], slowMs: number): LatencyStats | undefined {
  const durations: number[] = [];
  let slow = 0;
  for (const entry of entries) {
    if (typeof entry.durationMs === 'number') {
      durations.push(entry.durationMs);
      if (entry.durationMs >= slowMs) slow += 1;
    }
  }
  if (durations.length === 0) return undefined;
  durations.sort((a, b) => a - b);
  return {
    count: durations.length,
    p50: percentile(durations, 0.5),
    p95: percentile(durations, 0.95),
    p99: percentile(durations, 0.99),
    max: durations[durations.length - 1] ?? 0,
    slow,
  };
}

interface FamilyAccumulator {
  durations: number[];
  label: string;
}

function computeFamilies(entries: Entry[], topFamilies: number): FamilyLatency[] {
  const groups = new Map<string, FamilyAccumulator>();
  for (const entry of entries) {
    if (entry.familyHash === null) continue;
    const query = asQueryContent(entry.content);
    const existing = groups.get(entry.familyHash);
    if (existing) {
      if (typeof entry.durationMs === 'number') existing.durations.push(entry.durationMs);
    } else {
      groups.set(entry.familyHash, {
        durations: typeof entry.durationMs === 'number' ? [entry.durationMs] : [],
        label: query !== null ? query.sql.slice(0, MAX_FAMILY_LABEL_LENGTH) : '',
      });
    }
  }

  const families: FamilyLatency[] = [];
  for (const [familyHash, group] of groups) {
    const durations = [...group.durations].sort((a, b) => a - b);
    families.push({
      familyHash,
      label: group.label,
      count: durations.length,
      p50: percentile(durations, 0.5),
      p99: percentile(durations, 0.99),
    });
  }

  families.sort(
    (a, b) => b.p99 - a.p99 || b.count - a.count || a.familyHash.localeCompare(b.familyHash),
  );
  return families.slice(0, topFamilies);
}

function computeCache(entries: Entry[], topKeys: number): CacheStats {
  let hits = 0;
  let misses = 0;
  let sets = 0;
  const keyCounts = new Map<string, number>();

  for (const entry of entries) {
    const cache = asCacheContent(entry.content);
    if (cache === null) continue;
    keyCounts.set(cache.key, (keyCounts.get(cache.key) ?? 0) + 1);
    if (cache.operation === 'set') {
      sets += 1;
    } else if (cache.hit === true) {
      hits += 1;
    } else if (cache.hit === false) {
      misses += 1;
    }
  }

  const denominator = hits + misses;
  const ranked = [...keyCounts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, topKeys);

  return {
    hits,
    misses,
    sets,
    hitRatio: denominator === 0 ? 0 : hits / denominator,
    topKeys: ranked,
  };
}

function computeStatus(entries: Entry[]): StatusBreakdown {
  const breakdown: StatusBreakdown = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 };
  for (const entry of entries) {
    const request = asRequestContent(entry.content);
    const code = request?.statusCode ?? null;
    if (code !== null && code >= 200 && code < 300) breakdown['2xx'] += 1;
    else if (code !== null && code >= 300 && code < 400) breakdown['3xx'] += 1;
    else if (code !== null && code >= 400 && code < 500) breakdown['4xx'] += 1;
    else if (code !== null && code >= 500 && code < 600) breakdown['5xx'] += 1;
    else breakdown.other += 1;
  }
  return breakdown;
}

interface ExceptionAccumulator {
  class: string;
  message: string;
  count: number;
  lastAt: Date;
  overTime: number[];
}

/** The family key for an exception entry: its `familyHash` when present (the
 *  interceptor sets `${class}:${message}`), else a `${class}: ${message}`
 *  fallback derived from content. */
function exceptionKey(entry: Entry, fields: Pick<ExceptionContent, 'class' | 'message'>): string {
  return entry.familyHash ?? `${fields.class}: ${fields.message}`;
}

/** The bucket index a timestamp falls into for the report's `overTime` buckets;
 *  mirrors {@link bucketTimeseries}'s clamping so the per-group series aligns. */
function bucketIndexFor(
  createdAt: Date,
  windowStart: Date,
  windowEnd: Date,
  bucketCount: number,
): number {
  const count = Math.max(1, Math.floor(bucketCount));
  const startMs = windowStart.getTime();
  const spanMs = Math.max(1, windowEnd.getTime() - startMs);
  const bucketMs = Math.max(1, Math.floor(spanMs / count));
  const rawIndex = Math.floor((createdAt.getTime() - startMs) / bucketMs);
  return Math.min(count - 1, Math.max(0, rawIndex));
}

function computeExceptions(
  entries: Entry[],
  windowStart: Date,
  windowEnd: Date,
  buckets: number,
  topExceptions: number,
): ExceptionGroupStats[] {
  const bucketCount = Math.max(1, Math.floor(buckets));
  const groups = new Map<string, ExceptionAccumulator>();

  for (const entry of entries) {
    const fields = asExceptionContent(entry.content);
    if (fields === null) continue;
    const key = exceptionKey(entry, fields);
    const index = bucketIndexFor(entry.createdAt, windowStart, windowEnd, bucketCount);
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (entry.createdAt > existing.lastAt) existing.lastAt = entry.createdAt;
      const current = existing.overTime[index] ?? 0;
      existing.overTime[index] = current + 1;
    } else {
      const overTime = new Array<number>(bucketCount).fill(0);
      overTime[index] = 1;
      groups.set(key, {
        class: fields.class,
        message: fields.message,
        count: 1,
        lastAt: entry.createdAt,
        overTime,
      });
    }
  }

  return [...groups.entries()]
    .map(([key, group]) => ({ key, ...group }))
    .sort(
      (a, b) =>
        b.count - a.count || b.lastAt.getTime() - a.lastAt.getTime() || a.key.localeCompare(b.key),
    )
    .slice(0, topExceptions);
}

/** Aggregate a window of entries into per-type analytics: latency percentiles,
 *  query-family breakdown, cache hit/miss, request status breakdown, and a
 *  throughput time-series. Pure: callers fetch the windowed entries and supply
 *  the window bounds + `truncated` flag. */
export function summarizeStats(input: SummarizeStatsInput): StatsResult {
  const {
    entries,
    type,
    windowStart,
    windowEnd,
    windowMs,
    buckets,
    slowMs,
    truncated,
    topFamilies = DEFAULT_TOP_FAMILIES,
    topKeys = DEFAULT_TOP_KEYS,
    topExceptions = DEFAULT_TOP_EXCEPTIONS,
  } = input;

  const overTime = bucketTimeseries(entries, windowStart, windowEnd, buckets);
  const latency = computeLatency(entries, slowMs);

  const result: StatsResult = {
    type,
    windowMs,
    total: entries.length,
    overTime,
    truncated,
  };

  if (latency !== undefined) result.latency = latency;
  if (type === EntryType.Query) {
    const families = computeFamilies(entries, topFamilies);
    if (families.length > 0) result.families = families;
  }
  if (type === EntryType.Cache) result.cache = computeCache(entries, topKeys);
  if (type === EntryType.Request) result.status = computeStatus(entries);
  if (type === EntryType.Exception) {
    const exceptions = computeExceptions(entries, windowStart, windowEnd, buckets, topExceptions);
    if (exceptions.length > 0) result.exceptions = exceptions;
  }

  return result;
}
