import { createHash } from 'node:crypto';
import { type Duration, HISTOGRAM_BUCKET_COUNT, durationToMs } from '@dudousxd/nestjs-telescope';

/** How long entries live, by type. Enforced by the table's TTL, so nothing prunes rows. */
export interface ClickHouseRetention {
  /** Applies to every type without its own entry in `perType`. */
  default: Duration;
  perType?: Record<string, Duration>;
}

export const DEFAULT_RETENTION: ClickHouseRetention = { default: '24h' };

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/** Table names are interpolated into DDL, so only plain (optionally db-qualified) identifiers pass. */
export function assertIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`Invalid ClickHouse table name "${name}": use [A-Za-z_][A-Za-z0-9_]*`);
  }
  return name;
}

function literal(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function seconds(duration: Duration): number {
  const ms = durationToMs(duration);
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`Invalid retention duration: ${duration}`);
  return Math.ceil(ms / 1000);
}

/**
 * The entries table's TTL clause. Every per-type rule is scoped to its type and the default rule
 * excludes those types: an unconditional default would otherwise expire a type kept for 90 days
 * at the default's 24 hours.
 */
export function entriesTtl(retention: ClickHouseRetention): string {
  const perType = Object.entries(retention.perType ?? {});
  const rules = perType.map(
    ([type, duration]) =>
      `toDateTime(created_at) + toIntervalSecond(${seconds(duration)}) DELETE WHERE type = ${literal(type)}`,
  );
  const fallback = `toDateTime(created_at) + toIntervalSecond(${seconds(retention.default)})`;
  rules.push(
    perType.length > 0
      ? `${fallback} DELETE WHERE type NOT IN (${perType.map(([type]) => literal(type)).join(', ')})`
      : fallback,
  );
  return rules.join(',\n  ');
}

/** Rollup buckets live as long as the longest-kept entry type. */
export function rollupsTtl(retention: ClickHouseRetention): string {
  const longest = Math.max(
    seconds(retention.default),
    ...Object.values(retention.perType ?? {}).map(seconds),
  );
  return `toDateTime(bucket_start) + toIntervalSecond(${longest})`;
}

/** Fingerprint of a TTL clause, kept in the table comment so boot only re-applies a changed TTL. */
export function ttlFingerprint(ttl: string): string {
  return `telescope-ttl:${createHash('sha256').update(ttl).digest('hex').slice(0, 16)}`;
}

export const HISTOGRAM_COLUMNS = Array.from(
  { length: HISTOGRAM_BUCKET_COUNT },
  (_, index) => `h${index}`,
);

export function createEntriesTable(table: string, ttl: string): string {
  return `CREATE TABLE IF NOT EXISTS ${table} (
  id String,
  batch_id String,
  type LowCardinality(String),
  family_hash Nullable(String),
  content String CODEC(ZSTD(3)),
  tags Array(String),
  sequence Int64,
  duration_ms Nullable(Float64),
  origin LowCardinality(String),
  instance_id LowCardinality(String),
  trace_id Nullable(String),
  span_id Nullable(String),
  created_at DateTime64(3, 'UTC'),
  version UInt64,
  is_deleted UInt8 DEFAULT 0,
  INDEX ix_id id TYPE bloom_filter GRANULARITY 4,
  INDEX ix_batch batch_id TYPE bloom_filter GRANULARITY 4,
  INDEX ix_trace trace_id TYPE bloom_filter GRANULARITY 4,
  INDEX ix_family family_hash TYPE bloom_filter GRANULARITY 4,
  INDEX ix_tags tags TYPE bloom_filter GRANULARITY 4,
  INDEX ix_duration duration_ms TYPE minmax GRANULARITY 4
)
ENGINE = ReplacingMergeTree(version, is_deleted)
PARTITION BY toYYYYMMDD(created_at)
ORDER BY (type, created_at, id)
TTL ${ttl}
COMMENT ${literal(ttlFingerprint(ttl))}`;
}

export function createRollupsTable(table: string, ttl: string): string {
  const histogram = HISTOGRAM_COLUMNS.map((column) => `  ${column} UInt64,`).join('\n');
  return `CREATE TABLE IF NOT EXISTS ${table} (
  metric LowCardinality(String),
  bucket_start DateTime64(3, 'UTC'),
  count UInt64,
  sum Float64,
  max SimpleAggregateFunction(max, Float64),
${histogram}
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (metric, bucket_start)
TTL ${ttl}
COMMENT ${literal(ttlFingerprint(ttl))}`;
}

export function modifyTtl(table: string, ttl: string): string[] {
  return [
    `ALTER TABLE ${table} MODIFY TTL ${ttl}`,
    `ALTER TABLE ${table} MODIFY COMMENT ${literal(ttlFingerprint(ttl))}`,
  ];
}
