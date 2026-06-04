// packages/core/src/rollup/rollup-store.ts

/** One minute is the base rollup granularity. */
export const ROLLUP_BUCKET_MS = 60_000;

/**
 * Upper boundaries (inclusive, in ms) for the pre-aggregated latency histogram.
 * Bucket `i` counts durations `d` where `d <= LATENCY_BOUNDARIES_MS[i]` and
 * `d > LATENCY_BOUNDARIES_MS[i-1]`. A final OVERFLOW bucket (index
 * `LATENCY_BOUNDARIES_MS.length`) counts everything greater than the last
 * boundary, so a histogram always has `LATENCY_BOUNDARIES_MS.length + 1` cells.
 */
export const LATENCY_BOUNDARIES_MS: readonly number[] = [
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
];

/** The fixed cell count of every latency histogram (boundaries + 1 overflow). */
export const HISTOGRAM_BUCKET_COUNT = LATENCY_BOUNDARIES_MS.length + 1;

/** A fresh, all-zeros histogram of the canonical fixed length. */
export function emptyHistogram(): number[] {
  return new Array<number>(HISTOGRAM_BUCKET_COUNT).fill(0);
}

/**
 * The histogram cell a duration falls in: the first index `i` where
 * `durationMs <= LATENCY_BOUNDARIES_MS[i]`, else the overflow index. Negative or
 * zero durations land in cell 0.
 */
export function histogramBucketIndex(durationMs: number): number {
  for (let index = 0; index < LATENCY_BOUNDARIES_MS.length; index += 1) {
    const boundary = LATENCY_BOUNDARIES_MS[index];
    if (boundary !== undefined && durationMs <= boundary) return index;
  }
  return LATENCY_BOUNDARIES_MS.length;
}

/**
 * Increments the histogram cell for `durationMs` by one, in place. Safe against
 * the index typing (always a valid in-range cell of a fixed-length array).
 */
export function incrementHistogram(histogram: number[], durationMs: number): void {
  const index = histogramBucketIndex(durationMs);
  histogram[index] = (histogram[index] ?? 0) + 1;
}

/**
 * Normalizes a (possibly legacy/undefined) stored histogram into a fixed-length
 * zero-padded array. Legacy rollup rows with no histogram read back as all-zeros
 * of the canonical length — never NaN, never a wrong width.
 */
export function normalizeHistogram(histogram: number[] | null | undefined): number[] {
  const normalized = emptyHistogram();
  if (!Array.isArray(histogram)) return normalized;
  for (let index = 0; index < HISTOGRAM_BUCKET_COUNT; index += 1) {
    const value = histogram[index];
    normalized[index] = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }
  return normalized;
}

/**
 * Element-wise additive merge of `addend` into `target` (mutates and returns
 * `target`). Both are normalized first, so legacy/short arrays are safe.
 */
export function mergeHistograms(target: number[], addend: number[] | null | undefined): number[] {
  const left = normalizeHistogram(target);
  const right = normalizeHistogram(addend);
  for (let index = 0; index < HISTOGRAM_BUCKET_COUNT; index += 1) {
    left[index] = (left[index] ?? 0) + (right[index] ?? 0);
  }
  return left;
}

/** Floors an epoch-ms timestamp to the start of its 1-minute rollup bucket. */
export function floorToBucket(epochMs: number): number {
  return Math.floor(epochMs / ROLLUP_BUCKET_MS) * ROLLUP_BUCKET_MS;
}

/** An additive aggregate for (metric, bucketStart). metric = the entry `type` for now. */
export interface RollupDelta {
  metric: string;
  bucketStart: number;
  count: number;
  sum: number;
  max: number;
  /** Fixed-length ({@link HISTOGRAM_BUCKET_COUNT}) latency histogram for this group. */
  histogram: number[];
}

/** A materialized rollup row for (metric, bucketStart). */
export interface RollupBucket {
  metric: string;
  bucketStart: number;
  count: number;
  sum: number;
  max: number;
  /** Fixed-length ({@link HISTOGRAM_BUCKET_COUNT}) latency histogram for this bucket. */
  histogram: number[];
}

/**
 * Optional SPI a {@link StorageProvider} MAY also implement to support
 * pre-aggregated rollups. Detected at runtime via {@link isRollupStore}; it is
 * deliberately NOT part of the StorageProvider interface, so stores that do not
 * implement it keep working via the raw-scan fallback.
 */
export interface RollupStore {
  /**
   * Additively merge deltas into the rollup table (accumulate count/sum, keep a
   * running max). Idempotent per (metric, bucketStart) via upsert + increment.
   */
  recordRollups(deltas: RollupDelta[]): Promise<void>;
  /**
   * Buckets for the given metrics whose bucketStart is in [fromBucket, toBucket].
   * Order unspecified.
   */
  queryRollups(metrics: string[], fromBucket: number, toBucket: number): Promise<RollupBucket[]>;
}

function hasFunction(value: object, key: string): boolean {
  return key in value && typeof Reflect.get(value, key) === 'function';
}

/** Duck-types `s` as a {@link RollupStore} (recordRollups & queryRollups present). */
export function isRollupStore(s: object): s is RollupStore {
  return hasFunction(s, 'recordRollups') && hasFunction(s, 'queryRollups');
}
