// packages/core/src/rollup/estimate-percentile.ts
import { LATENCY_BOUNDARIES_MS, normalizeHistogram } from './rollup-store.js';

/**
 * Estimates a percentile from a pre-aggregated latency histogram (O(buckets),
 * no raw scan). Nearest-rank style at BUCKET resolution: the result is the UPPER
 * boundary of the bucket that contains the target rank, so the estimate is an
 * APPROXIMATION whose error is bounded by that bucket's width.
 *
 * - `total = Σ histogram`; `target rank = fraction * total` (1-based, matching
 *   the raw nearest-rank `Math.ceil(fraction * n)`).
 * - Walk the cumulative count until it reaches/crosses the target rank; return
 *   the containing bucket's upper boundary.
 * - The OVERFLOW bucket (values greater than the last boundary) has no finite
 *   upper boundary; we return the LAST boundary as a safe finite representative
 *   (documented under-estimate for the unbounded tail, never `Infinity`).
 * - Returns 0 when the histogram is empty / total is 0.
 *
 * @param histogram fixed-length latency histogram (legacy/short arrays are
 *   normalized to zeros first, so this never throws or yields NaN).
 * @param fraction percentile fraction in [0, 1] (e.g. 0.5, 0.95, 0.99).
 */
export function estimatePercentileFromHistogram(histogram: number[], fraction: number): number {
  const cells = normalizeHistogram(histogram);
  let total = 0;
  for (const count of cells) total += count;
  if (total <= 0) return 0;

  const boundedFraction = Math.min(1, Math.max(0, fraction));
  // 1-based target rank, mirroring the raw `Math.ceil(q * n)` nearest-rank rule.
  const targetRank = Math.max(1, Math.ceil(boundedFraction * total));

  const lastBoundary = LATENCY_BOUNDARIES_MS[LATENCY_BOUNDARIES_MS.length - 1] ?? 0;

  let cumulative = 0;
  for (let index = 0; index < cells.length; index += 1) {
    cumulative += cells[index] ?? 0;
    if (cumulative >= targetRank) {
      // Boundary buckets return their inclusive upper edge; the overflow bucket
      // (index === LATENCY_BOUNDARIES_MS.length) caps to the last finite boundary.
      return LATENCY_BOUNDARIES_MS[index] ?? lastBoundary;
    }
  }
  // Unreachable when total > 0 (cumulative ends at total >= targetRank), but
  // return the last boundary as a defensive finite fallback.
  return lastBoundary;
}
