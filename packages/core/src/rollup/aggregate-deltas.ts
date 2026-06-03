// packages/core/src/rollup/aggregate-deltas.ts
import type { Entry } from '../entry/entry.js';
import { type RollupDelta, floorToBucket } from './rollup-store.js';

/**
 * Folds a batch of entries into additive rollup deltas, grouped by
 * `(type, floorToBucket(createdAt))`. Pure & deterministic:
 * - `count` = number of entries in the group,
 * - `sum`   = Σ durationMs (null treated as 0),
 * - `max`   = max durationMs (0 when every entry's durationMs is null).
 */
export function aggregateDeltas(entries: Entry[]): RollupDelta[] {
  const groups = new Map<string, RollupDelta>();
  for (const entry of entries) {
    const bucketStart = floorToBucket(entry.createdAt.getTime());
    const key = `${entry.type}|${bucketStart}`;
    const duration = entry.durationMs ?? 0;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        metric: entry.type,
        bucketStart,
        count: 1,
        sum: duration,
        max: duration,
      });
    } else {
      existing.count += 1;
      existing.sum += duration;
      existing.max = Math.max(existing.max, duration);
    }
  }
  return [...groups.values()];
}
