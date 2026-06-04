// packages/mikro-orm/src/telescope-rollup.entity.ts
//
// Pre-aggregated rollup persistence schema, defined via EntitySchema (NOT
// decorators) so the host does not need emitDecoratorMetadata. Mirrors the
// `telescope_rollups` table the core SqliteStorageProvider owns:
//
//   (metric, bucket_start) composite primary key, with additive count/sum and a
//   running max aggregate per 1-minute bucket.
//
// The MikroOrmStorageProvider registers this entity in its OWNED single-purpose
// ORM alongside `TelescopeEntry`, so `schema.update({ safe: true })` self-heals
// the table additively at boot (creates it; never drops).
import { BigIntType, EntitySchema } from '@mikro-orm/core';

export interface TelescopeRollupRow {
  metric: string;
  bucketStart: number;
  count: number;
  sum: number;
  max: number;
  /** Fixed-length latency histogram (JSON column); null on legacy rows. */
  histogram: number[] | null;
}

// `bucket_start` is an epoch-ms timestamp and count/sum/max are accumulating
// aggregates, so a true SQL BIGINT column is the right width on MySQL. We pin
// BigIntType to `number` mode (instead of the default `bigint`) so the JS-side
// values are plain numbers — telescope rollup counts/sums stay well within
// Number.MAX_SAFE_INTEGER, and it keeps the row interface cast-free.
function bigintNumber(): BigIntType<'number'> {
  return new BigIntType('number');
}

export const TelescopeRollup = new EntitySchema<TelescopeRollupRow>({
  name: 'TelescopeRollup',
  tableName: 'telescope_rollups',
  properties: {
    metric: { type: 'string', primary: true, length: 64 },
    bucketStart: { type: bigintNumber(), primary: true, fieldName: 'bucket_start' },
    count: { type: bigintNumber(), fieldName: 'count' },
    sum: { type: bigintNumber(), fieldName: 'sum' },
    max: { type: bigintNumber(), fieldName: 'max' },
    // JSON-typed fixed-length latency histogram. Nullable so `schema.update({
    // safe })` can self-heal it additively onto a legacy table whose rows
    // predate the column (those read back null → normalized to zeros).
    histogram: { type: 'json', fieldName: 'histogram', nullable: true },
  },
});
