/**
 * The client half of the table SPI: turning a panel's live table state into the
 * query its provider is re-resolved with.
 *
 * The param names below are the wire contract, and the server half of it lives
 * in `@dudousxd/nestjs-telescope`'s `readTableQuery`. They are duplicated rather
 * than imported: `src/client` and `src/react` deliberately carry no dependency
 * on the core package (see the `Panel` doc in `../../../client/types.ts`), and a
 * type-only mirror is what keeps a host from installing a NestJS server package
 * to render a table. Change one, change the other.
 */

/** Query-param key naming the column the table is sorted by. */
export const TABLE_SORT_PARAM = 'sort';

/** Query-param key carrying the sort direction. */
export const TABLE_SORT_DIR_PARAM = 'dir';

/** Prefix that namespaces a per-column filter — `filter.status=failed`. */
export const TABLE_FILTER_PREFIX = 'filter.';

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
  paging?: { page: number; limit: number };
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
 * Filters are namespaced with `filter.` for the same reason the server reads
 * them that way: a panel scoped to `{ status: 'running' }` with a filterable
 * `status` column is an ordinary combination, and unprefixed one would silently
 * overwrite the other.
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
    query.limit = state.paging.limit;
  }
  if (state.sort) {
    query[TABLE_SORT_PARAM] = state.sort.key;
    query[TABLE_SORT_DIR_PARAM] = state.sort.dir;
  }
  for (const [key, value] of filters) query[`${TABLE_FILTER_PREFIX}${key}`] = value;
  return query;
}
