// packages/core/src/metrics/timeseries.ts
import type { Entry } from '../entry/entry.js';

export interface TimeseriesBucket {
  /** ISO timestamp of the bucket's start. */
  t: string;
  total: number;
  byType: Record<string, number>;
}

export interface TimeseriesReport {
  windowStart: string;
  windowEnd: string;
  bucketMs: number;
  buckets: TimeseriesBucket[];
}

/** Group entries into `bucketCount` equal time buckets across [windowStart,
 *  windowEnd], counting total + per-type per bucket. Pure: callers fetch the
 *  windowed entries. Out-of-range entries are clamped into the edge buckets. */
export function bucketTimeseries(
  entries: Entry[],
  windowStart: Date,
  windowEnd: Date,
  bucketCount: number,
): TimeseriesReport {
  const count = Math.max(1, Math.floor(bucketCount));
  const startMs = windowStart.getTime();
  const spanMs = Math.max(1, windowEnd.getTime() - startMs);
  const bucketMs = Math.max(1, Math.floor(spanMs / count));

  const buckets: TimeseriesBucket[] = Array.from({ length: count }, (_, index) => ({
    t: new Date(startMs + index * bucketMs).toISOString(),
    total: 0,
    byType: {},
  }));

  for (const entry of entries) {
    const offset = entry.createdAt.getTime() - startMs;
    const rawIndex = Math.floor(offset / bucketMs);
    const index = Math.min(count - 1, Math.max(0, rawIndex));
    const bucket = buckets[index];
    if (!bucket) continue;
    bucket.total += 1;
    bucket.byType[entry.type] = (bucket.byType[entry.type] ?? 0) + 1;
  }

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    bucketMs,
    buckets,
  };
}

/** The buckets {@link bucketTimeseries} splits a window into: `count` of `bucketMs` from `startMs`. */
export function bucketGeometry(
  windowStart: Date,
  windowEnd: Date,
  bucketCount: number,
): { startMs: number; bucketMs: number; count: number } {
  const count = Math.max(1, Math.floor(bucketCount));
  const startMs = windowStart.getTime();
  const spanMs = Math.max(1, windowEnd.getTime() - startMs);
  return { startMs, bucketMs: Math.max(1, Math.floor(spanMs / count)), count };
}

/**
 * The report {@link bucketTimeseries} gives, from per-(type, bucket) counts a store computed (the
 * `count` aggregation with a bucket). Bucket indexes outside the window are clamped into the edge
 * buckets, as the scan does. `scanned` is how many entries the counts hold.
 */
export function timeseriesFromCounts(
  rows: readonly { type: string; bucket: number | null; count: number }[],
  windowStart: Date,
  windowEnd: Date,
  bucketCount: number,
): TimeseriesReport & { scanned: number } {
  const { startMs, bucketMs, count } = bucketGeometry(windowStart, windowEnd, bucketCount);
  const buckets: TimeseriesBucket[] = Array.from({ length: count }, (_, index) => ({
    t: new Date(startMs + index * bucketMs).toISOString(),
    total: 0,
    byType: {},
  }));
  let scanned = 0;
  for (const row of rows) {
    const index = Math.min(count - 1, Math.max(0, row.bucket ?? 0));
    const bucket = buckets[index];
    if (!bucket) continue;
    bucket.total += row.count;
    bucket.byType[row.type] = (bucket.byType[row.type] ?? 0) + row.count;
    scanned += row.count;
  }
  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    bucketMs,
    buckets,
    scanned,
  };
}
