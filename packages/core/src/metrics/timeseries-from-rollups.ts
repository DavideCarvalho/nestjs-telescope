// packages/core/src/metrics/timeseries-from-rollups.ts
import type { RollupBucket } from '../rollup/rollup-store.js';
import type { TimeseriesBucket, TimeseriesReport } from './timeseries.js';

/**
 * Assembles the SAME {@link TimeseriesReport} shape {@link bucketTimeseries}
 * produces, but from pre-aggregated 1-minute {@link RollupBucket}s instead of a
 * raw entry scan. Each rollup's `count` is placed (re-bucketed) into the report
 * bucket its `bucketStart` falls in, using the IDENTICAL clamp formula
 * `bucketTimeseries` uses for an entry's `createdAt`. When the report's bucket
 * width is a multiple of (and aligned to) the 1-minute rollup granularity, this
 * reproduces the raw-scan counts exactly.
 */
export function timeseriesFromRollups(
  rollups: RollupBucket[],
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

  for (const rollup of rollups) {
    const offset = rollup.bucketStart - startMs;
    const rawIndex = Math.floor(offset / bucketMs);
    const index = Math.min(count - 1, Math.max(0, rawIndex));
    const bucket = buckets[index];
    if (!bucket) continue;
    bucket.total += rollup.count;
    bucket.byType[rollup.metric] = (bucket.byType[rollup.metric] ?? 0) + rollup.count;
  }

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    bucketMs,
    buckets,
  };
}
