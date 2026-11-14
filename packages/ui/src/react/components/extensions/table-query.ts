/**
 * The client half of the table wire: turning a panel's live table state into the
 * query its provider is re-resolved with, in the Aviary list API's shape:
 *
 * ```text
 * ?page=2&size=50&sort=-startedAt&filter[status]=failed
 * ```
 *
 * The server half is `@dudousxd/nestjs-telescope`'s `ext/:ext/data/:provider` route, which
 * translates this wire to the provider SPI (`readTableQuery`: `page` / `limit` / `sort` + `dir` /
 * `filter.<col>`, unchanged) and the provider's `{ rows, total, page, limit }` to the offset list
 * `{ data, meta }`. The names are duplicated rather than imported: `src/client` and `src/react`
 * deliberately carry no dependency on the core package (see the `Panel` doc in
 * `../../../client/types.ts`), and a mirror is what keeps a host from installing a NestJS server
 * package to render a table. Change one, change the other.
 */

/** Query-param key carrying the sort: `name` ascending, `-name` descending. */
export const TABLE_SORT_PARAM = 'sort';

/** Query-param key of the page size. */
export const TABLE_SIZE_PARAM = 'size';

/** A per-column filter's query-param key: `filter[status]`. */
export function tableFilterParam(column: string): string {
  return `filter[${column}]`;
}

/** Which column a table is sorted by, and which way. `undefined` means unsorted. */
export interface TableSortState {
  /** The panel `Column.key` of the sorted column. */
  key: string;
  dir: 'asc' | 'desc';
}

/** Committed per-column filter text, keyed by panel `Column.key`. */
export type TableFilterState = Record<string, string>;

/** Everything a table panel can add to its provider query beyond `data.query`. */
export interface TableQueryState {
  /** Present only for a `paged: true` panel. */
  paging?: { page: number; size: number };
  sort?: TableSortState;
  filters?: TableFilterState;
}

/**
 * Merges a table's live state onto the panel's own static `data.query`.
 *
 * Returns `base` **by identity** when there is nothing to merge. That is not a
 * micro-optimisation: the resolved query is part of the React Query cache key,
 * so a table that has never been sorted or filtered has to produce the exact
 * query it produced before this feature existed — otherwise every existing
 * dashboard would quietly start on a fresh cache entry, and a plain table's
 * request would no longer be deduplicated against an identical panel elsewhere
 * on the page.
 *
 * Filters are namespaced as `filter[col]` for the same reason the provider
 * reads them namespaced: a panel scoped to `{ status: 'running' }` with a
 * filterable `status` column is an ordinary combination, and unprefixed one
 * would silently overwrite the other.
 */
export function buildTableQuery(
  base: Record<string, unknown> | undefined,
  state: TableQueryState,
): Record<string, unknown> | undefined {
  const filters = Object.entries(state.filters ?? {}).filter(([, value]) => value !== '');
  if (!state.paging && !state.sort && filters.length === 0) return base;

  const query: Record<string, unknown> = { ...base };
  if (state.paging) {
    query.page = state.paging.page;
    query[TABLE_SIZE_PARAM] = state.paging.size;
  }
  if (state.sort) {
    query[TABLE_SORT_PARAM] = `${state.sort.dir === 'desc' ? '-' : ''}${state.sort.key}`;
  }
  for (const [key, value] of filters) query[tableFilterParam(key)] = value;
  return query;
}
