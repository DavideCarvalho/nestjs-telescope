// packages/core/src/extension/table-query.ts

/**
 * The wire contract for a `table` panel's sort/filter state, and the helper a
 * provider uses to read it back.
 *
 * Sorting and filtering a dashboard table are done **server-side**: the UI never
 * holds more than the page it is showing, so sorting in the browser would sort
 * 50 rows out of 50,000 and quietly present the result as "the top of the list".
 * The state therefore travels to the provider the same way `page`/`limit`
 * already do — merged into the panel's `data.query` and serialized as query
 * params on `GET /telescope/api/ext/<ext>/data/<provider>`.
 *
 * Everything here is **additive**: a provider that never reads these params
 * behaves exactly as it did before they existed, and a panel whose columns
 * declare no `sortable`/`filterable` flag never sends them.
 *
 * The wire shape, flat because the query object is serialized through
 * `URLSearchParams` (a nested object would arrive as the string
 * `"[object Object]"`):
 *
 * ```text
 * ?page=2&limit=50&sort=duration&dir=desc&filter.status=failed
 * ```
 *
 * Note that params arrive as **strings** — the host controller passes
 * `@Query()` through verbatim — which is exactly the trap {@link readTableQuery}
 * exists to close: `query.page > 1` is `false` for the string `'2'`, silently,
 * with no type error to catch it.
 */

/** Query-param key naming the column the table is sorted by. */
export const TABLE_SORT_PARAM = 'sort';

/** Query-param key carrying the sort direction (`'asc'` / `'desc'`). */
export const TABLE_SORT_DIR_PARAM = 'dir';

/**
 * Prefix that namespaces a per-column filter — `filter.status=failed` filters
 * the column whose `key` is `status`.
 *
 * Prefixed rather than flat so a filterable column can never collide with a
 * param the panel itself declared in `data.query` (a panel with a static
 * `{ status: 'running' }` scope AND a filterable `status` column is an ordinary
 * combination, and one silently overwriting the other would be a bug nobody
 * could see from the outside).
 */
export const TABLE_FILTER_PREFIX = 'filter.';

/** Which column a table is sorted by, and which way. */
export interface TableSort {
  /** The `Column.key` of the sorted column. */
  key: string;
  dir: 'asc' | 'desc';
}

/** A table panel's paging + sort + filter request, normalized off the raw query. */
export interface TableQuery {
  /** 1-based page, present only for a `paged: true` panel. */
  page?: number;
  /** Requested page size, present only for a `paged: true` panel. */
  limit?: number;
  /** Absent when the table is unsorted (the provider's own default order wins). */
  sort?: TableSort;
  /** Per-column filter text, keyed by `Column.key`. Empty when nothing is filtered. */
  filters: Record<string, string>;
}

/**
 * Reads a positive integer out of a raw query value.
 *
 * Accepts a number as well as a string because the same query object is built
 * client-side (real numbers) and read back off the URL (strings), and a provider
 * unit-tested with `{ page: 2 }` must agree with the same provider serving
 * `?page=2`.
 */
function readPositiveInt(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Anything that isn't a non-empty string is not a filter — including `''`, which
 *  is what an emptied filter box sends and means "no filter", not "match empty". */
function readFilterValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * Normalizes the sort/filter/paging params out of a provider's raw `query`.
 *
 * Written as a guard-per-field rather than a cast: `query` is genuinely
 * untrusted — it is whatever was in the URL — and every field has a safe absent
 * behaviour, so a hand-typed `?sort=` or `?page=banana` degrades to "unsorted" /
 * "first page" instead of reaching a SQL builder as `NaN`.
 *
 * @example
 * ```ts
 * const provider: DataProvider = {
 *   name: 'durable.runs',
 *   async resolve(query) {
 *     const { page = 1, limit = 50, sort, filters } = readTableQuery(query);
 *     const rows = await store.findRuns({
 *       offset: (page - 1) * limit,
 *       limit,
 *       orderBy: sort ? { [sort.key]: sort.dir } : { startedAt: 'desc' },
 *       where: filters,
 *     });
 *     return { rows: rows.items, total: rows.total, page, limit };
 *   },
 * };
 * ```
 */
export function readTableQuery(query: Record<string, unknown> | undefined): TableQuery {
  const filters: Record<string, string> = {};
  const source = query ?? {};

  for (const [key, raw] of Object.entries(source)) {
    if (!key.startsWith(TABLE_FILTER_PREFIX)) continue;
    const column = key.slice(TABLE_FILTER_PREFIX.length);
    if (column === '') continue;
    const value = readFilterValue(raw);
    if (value !== undefined) filters[column] = value;
  }

  const page = readPositiveInt(source.page);
  const limit = readPositiveInt(source.limit);
  const sortKey = source[TABLE_SORT_PARAM];
  // A direction with no column is meaningless, so `sort` is keyed off the column
  // alone; anything other than an explicit `desc` reads as ascending.
  const sort: TableSort | undefined =
    typeof sortKey === 'string' && sortKey !== ''
      ? { key: sortKey, dir: source[TABLE_SORT_DIR_PARAM] === 'desc' ? 'desc' : 'asc' }
      : undefined;

  return {
    ...(page !== undefined ? { page } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(sort !== undefined ? { sort } : {}),
    filters,
  };
}
