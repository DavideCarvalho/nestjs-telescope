// packages/core/src/rollup/aggregate-deltas.ts
import type { Entry } from '../entry/entry.js';
import {
  type RollupDelta,
  emptyHistogram,
  floorToBucket,
  incrementHistogram,
} from './rollup-store.js';

/**
 * Folds a batch of entries into additive rollup deltas, grouped by
 * `(type, floorToBucket(createdAt))`. Pure & deterministic:
 * - `count` = number of entries in the group,
 * - `sum`   = Σ durationMs (null treated as 0),
 * - `max`   = max durationMs (0 when every entry's durationMs is null),
 * - `histogram` = fixed-size latency-bucket counts; ONLY entries with a non-null
 *   `durationMs` increment a cell (null durations contribute to count/sum/max as
 *   before but NOT to the histogram). Memory-safe: a small fixed-length integer
 *   array per group, never any retained entry references.
 */
export function aggregateDeltas(entries: Entry[]): RollupDelta[] {
  const groups = new Map<string, RollupDelta>();
  for (const entry of entries) {
    const bucketStart = floorToBucket(entry.createdAt.getTime());
    const key = `${entry.type}|${bucketStart}`;
    const duration = entry.durationMs ?? 0;
    const existing = groups.get(key);
    if (existing === undefined) {
      const histogram = emptyHistogram();
      if (entry.durationMs !== null) {
        incrementHistogram(histogram, entry.durationMs);
      }
      groups.set(key, {
        metric: entry.type,
        bucketStart,
        count: 1,
        sum: duration,
        max: duration,
        histogram,
      });
    } else {
      existing.count += 1;
      existing.sum += duration;
      existing.max = Math.max(existing.max, duration);
      if (entry.durationMs !== null) {
        incrementHistogram(existing.histogram, entry.durationMs);
      }
    }
  }
  return [...groups.values()];
}
