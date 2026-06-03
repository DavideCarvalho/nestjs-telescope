// packages/core/src/rollup/rollup-store.ts

/** One minute is the base rollup granularity. */
export const ROLLUP_BUCKET_MS = 60_000;

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
}

/** A materialized rollup row for (metric, bucketStart). */
export interface RollupBucket {
  metric: string;
  bucketStart: number;
  count: number;
  sum: number;
  max: number;
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
