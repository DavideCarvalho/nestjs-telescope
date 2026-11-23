// packages/drizzle/src/aggregate-sql.ts
//
// `StorageProvider.aggregate` in PostgreSQL: each kind is one or two GROUP BY statements over
// `telescope_entries`, so pulse and the timeseries read a window without paging its entries into
// Node. The statements are the PostgreSQL ones of `packages/mikro-orm/src/aggregate-sql.ts`; the
// two must answer alike, and both run the same `describeStorageAggregation` suite.
//
// Statements are written with `?` placeholders and numbered (`$1`, `$2`, ...) by `numbered()`
// just before they reach `pg`. Dates are bound as `Date` objects, which `pg` sends as timestamps
// with a zone, the way Drizzle binds them in `get`. Without `date_bin` (PostgreSQL before 14) the
// time buckets are a binary CASE tree over bucket boundaries.
//
// Only types are imported from the core: a value import would require the newer core at runtime.
import type {
  AggregateWindow,
  EntryAggregateResult,
  EntryAggregation,
} from '@dudousxd/nestjs-telescope';

export interface AggregateSqlContext {
  /** The entries table, quoted (and schema-qualified when configured). */
  table: string;
  /** Runs a statement written with `?` placeholders (see {@link numbered}). */
  execute: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;
  /**
   * PostgreSQL 14+: time buckets come from `date_bin`, about 2.5 times cheaper per row than the
   * CASE tree on a large window.
   */
  dateBin?: boolean;
}

/**
 * `sql` with each `?` outside a quoted literal or identifier replaced by `$1`, `$2`, ... in order:
 * the placeholders `pg` reads.
 */
export function numbered(sql: string): string {
  let out = '';
  let index = 0;
  let quote: string | null = null;
  for (const char of sql) {
    if (quote !== null) {
      if (char === quote) quote = null;
      out += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      out += char;
    } else if (char === '?') {
      index += 1;
      out += `$${index}`;
    } else {
      out += char;
    }
  }
  return out;
}

/** The 1-based nearest rank of quantile `q` among `n` values (the core's `quantileRank`). */
function quantileRank(q: number, n: number): number {
  return Math.min(n, Math.max(1, Math.ceil(q * n)));
}

const num = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));

/** Escapes LIKE wildcards; the statements say `escape '!'`. */
const escapeLike = (value: string): string => value.replace(/[!%_]/g, (char) => `!${char}`);

function windowWhere(
  context: AggregateSqlContext,
  window: AggregateWindow,
  params: unknown[],
): string {
  const where = ['created_at > ?'];
  params.push(window.after);
  if (window.before !== undefined) {
    where.push('created_at < ?');
    params.push(window.before);
  }
  if (window.type !== undefined) {
    where.push('type = ?');
    params.push(window.type);
  }
  if (window.types !== undefined) {
    if (window.types.length === 0) where.push('1 = 0');
    else {
      where.push(`type in (${window.types.map(() => '?').join(', ')})`);
      params.push(...window.types);
    }
  }
  if (window.tag !== undefined) {
    // The same match as `get`: the space-padded tag list contains ` <tag> `.
    where.push('tags_text like ?');
    params.push(`% ${window.tag} %`);
  }
  return where.join(' and ');
}

/**
 * The bucket index of `created_at` as a binary CASE tree: bucket `i` holds
 * `start + i * width <= created_at < start + (i + 1) * width`, clamped to `[0, count - 1]`.
 * About log2(count) comparisons per row, and nothing but comparisons.
 */
function bucketCase(
  context: AggregateSqlContext,
  startMs: number,
  widthMs: number,
  count: number,
  params: unknown[],
): string {
  const build = (low: number, high: number): string => {
    if (low === high) return String(low);
    const middle = (low + high + 1) >> 1;
    params.push(new Date(startMs + middle * widthMs));
    const left = build(low, middle - 1);
    const right = build(middle, high);
    return `(case when created_at < ? then ${left} else ${right} end)`;
  };
  return build(0, Math.max(0, count - 1));
}

/** A bound number as a double, so `q * n` rounds as it does in JavaScript. */
const BOUND_DOUBLE = 'cast(? as double precision)';

/** `ceil(x)` clamped to `[1, n]`. */
function clampedCeil(x: string): string {
  return `least(n, greatest(1, ceil(${x})))`;
}

/**
 * The bucketed count on PostgreSQL 14+: rows grouped by `date_bin` (one cheap call per row), the
 * bucket index computed once per group. Same buckets as the CASE tree: bucket `i` starts at
 * `startMs + i * widthMs`.
 */
async function countByDateBin(
  context: AggregateSqlContext,
  window: AggregateWindow,
  bucket: { startMs: number; widthMs: number },
): Promise<EntryAggregateResult> {
  const widthMs = Math.max(1, Math.floor(bucket.widthMs));
  const origin = new Date(bucket.startMs);
  const params: unknown[] = [`${widthMs} milliseconds`, origin];
  const where = windowWhere(context, window, params);
  params.push(origin, widthMs);
  const rows = await context.execute(
    `select type, round(extract(epoch from (bin - cast(? as timestamptz))) * 1000 / ?) as bucket, cnt
     from (
       select type, date_bin(cast(? as interval), created_at, cast(? as timestamptz)) as bin,
              count(*) as cnt
       from ${context.table} where ${where} group by 1, 2
     ) binned`,
    // The outer query's two parameters come first in the statement.
    [params[params.length - 2], params[params.length - 1], ...params.slice(0, -2)],
  );
  return {
    kind: 'count',
    rows: rows.map((row) => ({
      type: String(row.type),
      bucket: num(row.bucket),
      count: num(row.cnt),
    })),
  };
}

/** Runs one aggregation (see `StorageProvider.aggregate`). */
export async function aggregateSql(
  context: AggregateSqlContext,
  request: EntryAggregation,
): Promise<EntryAggregateResult> {
  const { table } = context;
  switch (request.kind) {
    case 'count': {
      if (request.bucket !== undefined && context.dateBin === true) {
        return countByDateBin(context, request.window, request.bucket);
      }
      const params: unknown[] = [];
      let bucket = 'null';
      // Bucket boundaries precede the window's parameters: the select list comes first.
      if (request.bucket !== undefined) {
        const widthMs = Math.max(1, Math.floor(request.bucket.widthMs));
        const end = request.window.before?.getTime() ?? Date.now();
        // Enough buckets to cover the window (and its future edge); the caller clamps the rest.
        const count = Math.min(
          2048,
          Math.max(1, Math.floor((end - request.bucket.startMs) / widthMs) + 1),
        );
        bucket = bucketCase(context, request.bucket.startMs, widthMs, count, params);
      }
      const where = windowWhere(context, request.window, params);
      const rows = await context.execute(
        `select type, ${bucket} as bucket, count(*) as cnt from ${table}
         where ${where} group by type${request.bucket !== undefined ? ', 2' : ''}`,
        params,
      );
      return {
        kind: 'count',
        rows: rows.map((row) => ({
          type: String(row.type),
          bucket: row.bucket === null || row.bucket === undefined ? null : num(row.bucket),
          count: num(row.cnt),
        })),
      };
    }
    case 'slowest': {
      const params: unknown[] = [];
      const where = windowWhere(context, request.window, params);
      params.push(Math.max(0, Math.floor(request.limit)));
      const rows = await context.execute(
        `select id, type, duration_ms, batch_id from ${table}
         where ${where} and duration_ms is not null
         order by duration_ms desc, id asc limit ?`,
        params,
      );
      return {
        kind: 'slowest',
        rows: rows.map((row) => ({
          id: String(row.id),
          type: String(row.type),
          durationMs: num(row.duration_ms),
          batchId: String(row.batch_id),
        })),
      };
    }
    case 'families': {
      const countTag = request.countTag;
      // The tag count is bound first (the select list), the window after: the space-padded tag
      // list contains ` <tag> `.
      const groupParams: unknown[] = countTag !== undefined ? [`% ${escapeLike(countTag)} %`] : [];
      const groupWhere = windowWhere(context, request.window, groupParams);
      const groups = await context.execute(
        `select type, family_hash, count(*) as cnt, count(duration_ms) as duration_count,
                coalesce(sum(duration_ms), 0) as duration_sum${
                  countTag !== undefined
                    ? ", sum(case when tags_text like ? escape '!' then 1 else 0 end) as tagged"
                    : ''
                }
         from ${table} where ${groupWhere} and family_hash is not null
         group by type, family_hash`,
        groupParams,
      );
      const valueAt = new Map<string, number>();
      if (request.quantiles.length > 0 && groups.length > 0) {
        // The quantiles are bound first (the select list), the window after.
        const params: unknown[] = [...request.quantiles];
        const where = windowWhere(context, request.window, params);
        const xs = request.quantiles
          .map((_, index) => `${BOUND_DOUBLE} * n as x${index}`)
          .join(', ');
        const ranked = await context.execute(
          `select type, family_hash, rn, duration_ms from (
             select type, family_hash, duration_ms, rn, n, ${xs} from (
               select type, family_hash, duration_ms,
                      row_number() over (partition by type, family_hash order by duration_ms) as rn,
                      count(*) over (partition by type, family_hash) as n
               from ${table}
               where ${where} and family_hash is not null and duration_ms is not null
             ) numbered
           ) ranked where ${request.quantiles.map((_, index) => `rn = ${clampedCeil(`x${index}`)}`).join(' or ')}`,
          params,
        );
        for (const row of ranked) {
          valueAt.set(
            `${row.type}\u0000${row.family_hash}\u0000${num(row.rn)}`,
            num(row.duration_ms),
          );
        }
      }
      return {
        kind: 'families',
        rows: groups.map((group) => {
          const n = num(group.duration_count);
          return {
            type: String(group.type),
            familyHash: String(group.family_hash),
            count: num(group.cnt),
            durationCount: n,
            durationSum: num(group.duration_sum),
            ...(countTag !== undefined ? { tagged: num(group.tagged) } : {}),
            quantiles: request.quantiles.map((q) =>
              n === 0
                ? 0
                : (valueAt.get(
                    `${group.type}\u0000${group.family_hash}\u0000${quantileRank(q, n)}`,
                  ) ?? 0),
            ),
          };
        }),
      };
    }
    case 'batchFamilies': {
      const params: unknown[] = [];
      const where = windowWhere(context, request.window, params);
      params.push(Math.max(1, Math.floor(request.minCount)));
      const rows = await context.execute(
        `select batch_id, family_hash, count(*) as cnt, coalesce(sum(duration_ms), 0) as duration_sum
         from ${table} where ${where} and family_hash is not null
         group by batch_id, family_hash having count(*) >= ?`,
        params,
      );
      return {
        kind: 'batchFamilies',
        rows: rows.map((row) => ({
          batchId: String(row.batch_id),
          familyHash: String(row.family_hash),
          count: num(row.cnt),
          durationSum: num(row.duration_sum),
        })),
      };
    }
    case 'tagSets': {
      const params: unknown[] = [];
      const where = windowWhere(context, request.window, params);
      // A tag starting with the prefix: a space (the padding or the separator) then the prefix.
      params.push(`% ${escapeLike(request.tagPrefix)}%`);
      // Grouped by the text form of the tag list; one list of each group is returned as is
      // (PostgreSQL has no `max(jsonb)`).
      const rows = await context.execute(
        `select (array_agg(tags))[1] as tags, count(*) as cnt, coalesce(sum(duration_ms), 0) as duration_sum
         from ${table} where ${where} and tags_text like ? escape '!'
         group by tags_text`,
        params,
      );
      return {
        kind: 'tagSets',
        rows: rows.map((row) => ({
          tags: parseTags(row.tags),
          count: num(row.cnt),
          durationSum: num(row.duration_sum),
        })),
      };
    }
  }
}

function parseTags(value: unknown): string[] {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed)
    ? parsed.filter((tag): tag is string => typeof tag === 'string')
    : [];
}
