// packages/core/src/nest/list-wire.ts
//
// Telescope's side of the Aviary list API (`./list-api.ts` is the shared, verbatim copy): the
// translations between the console's HTTP wire and the SPIs underneath it, which do not change.
import type { Panel } from '../extension/types.js';
import type { Page } from '../storage/storage-provider.js';
import {
  type CursorPageResponse,
  ListQueryError,
  type OffsetPage,
  type PageSizeOptions,
  cursorPage,
  offsetPage,
  parseFilterParams,
  parsePageParams,
  resolveSort,
} from './list-api.js';

type Query = Record<string, unknown>;

/**
 * Rejects parameters the list API removed, naming their replacement, so an old client gets a 400
 * that says what to send instead of a silently unfiltered or unpaged answer.
 */
export function rejectRemovedParams(query: Query, removed: Record<string, string>): void {
  for (const [name, replacement] of Object.entries(removed)) {
    const value = query[name];
    if (value !== undefined && value !== '') {
      throw new ListQueryError(`"${name}" is not a parameter of this list: use ${replacement}.`);
    }
  }
}

/** Reads a top-N `size` (no paging): `defaultSize` when absent, clamped to `maxSize`, 400 on junk. */
export function readSize(query: Query, options: PageSizeOptions): number {
  return parsePageParams({ size: query.size }, options).size;
}

/** A cursor page whose store cannot page backward: `before` / `last` are a 400. */
export function forwardOnly(query: Query): void {
  if ((query.before !== undefined && query.before !== '') || query.last !== undefined) {
    throw new ListQueryError('This list pages forward only: use "after" and "first".');
  }
}

/** A storage page as the cursor envelope; a tiered store's `partial` stays next to `data`. */
export function storagePage<T>(page: Page<T>): CursorPageResponse<T> & { partial?: true } {
  return {
    ...cursorPage(page.data, { nextCursor: page.nextCursor, prevCursor: null, hasPrev: false }),
    ...(page.partial ? { partial: true as const } : {}),
  };
}

// ── offset cursors (a store that pages by offset but cannot count) ─────────────

const OFFSET_CURSOR = /^o(\d{1,15})$/;

/** An opaque cursor for "resume at row `offset`". */
export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(`o${offset}`, 'utf8').toString('base64url');
}

/** The offset an {@link encodeOffsetCursor} cursor holds, or `null` when malformed. */
export function decodeOffsetCursor(cursor: string): number | null {
  const match = OFFSET_CURSOR.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  return match ? Number(match[1]) : null;
}

// ── extension table panels ─────────────────────────────────────────────────────

/** Page size bounds of a paged table panel. */
const TABLE_PAGE = { defaultSize: 50, maxSize: 500 } as const;

/** Keys the old table wire used; a list API request never sends them. */
const OLD_TABLE_PARAMS: Record<string, string> = {
  dir: '"sort=-column" for a descending sort',
  limit: '"size" with "page"',
};

/** The sortable and filterable column keys of every table panel bound to `provider`. */
export function tableColumnsOf(
  panels: Iterable<Panel>,
  provider: string,
): { sortable: string[]; filterable: string[] } {
  const sortable = new Set<string>();
  const filterable = new Set<string>();
  for (const panel of panels) {
    if (panel.kind !== 'table' || panel.data.provider !== provider) continue;
    for (const column of panel.columns) {
      if (column.sortable) sortable.add(column.key);
      if (column.filterable) filterable.add(column.key);
    }
  }
  return { sortable: [...sortable], filterable: [...filterable] };
}

/** What {@link toProviderQuery} read off the wire, besides the provider's query. */
export interface TableWire {
  /** The request asked for one page (`page` and/or `size`). */
  paged: { page: number; size: number } | null;
}

/**
 * Translates a panel request from the list API wire to the provider SPI's query, which does not
 * change (`readTableQuery` reads it):
 *
 * | Wire | Provider query |
 * |---|---|
 * | `page=2&size=50` | `page=2&limit=50` |
 * | `sort=-startedAt` | `sort=startedAt&dir=desc` |
 * | `filter[status]=failed` | `filter.status=failed` |
 *
 * Every other key is the panel's own `data.query` (or a drill-down) and passes through verbatim.
 * A sort or filter on a column no table panel of this provider marks `sortable` / `filterable`,
 * more than one sort field (the SPI sorts by one), or a key of the old table wire is a 400.
 */
export function toProviderQuery(
  query: Query,
  columns: { sortable: string[]; filterable: string[] },
): { query: Query; wire: TableWire } {
  for (const key of Object.keys(query)) {
    if (key.startsWith('filter.')) {
      throw new ListQueryError(`"${key}" is not a parameter: use "filter[${key.slice(7)}]".`);
    }
  }
  const out: Query = {};
  for (const [key, value] of Object.entries(query)) {
    if (key === 'page' || key === 'size' || key === 'sort' || key === 'filter') continue;
    if (key.startsWith('filter[')) continue;
    out[key] = value;
  }

  let paged: TableWire['paged'] = null;
  if (query.page !== undefined || query.size !== undefined) {
    rejectRemovedParams(query, OLD_TABLE_PARAMS);
    const { page, size } = parsePageParams(query, TABLE_PAGE);
    paged = { page, size };
    out.page = page;
    out.limit = size;
  }

  if (query.sort !== undefined && query.sort !== '') {
    if (query.dir !== undefined)
      rejectRemovedParams(query, { dir: OLD_TABLE_PARAMS.dir as string });
    const sort = resolveSort(query.sort, { sortable: columns.sortable });
    if (sort.length > 1) throw new ListQueryError('Sort this table by one column at a time.');
    const [first] = sort;
    if (first) {
      out.sort = first.field;
      out.dir = first.direction;
    }
  }

  const fields = Object.fromEntries(
    columns.filterable.map((key) => [key, ['eq', 'in'] as const]),
  ) as Record<string, readonly ['eq', 'in']>;
  for (const filter of parseFilterParams(query, { fields })) {
    // A filter box holds free text (the provider decides how it matches): a comma in it is text,
    // not a list.
    out[`filter.${filter.field}`] = Array.isArray(filter.value)
      ? filter.value.join(',')
      : filter.value;
  }
  return { query: out, wire: { paged } };
}

/**
 * A paged table provider's `{ rows, total, page, limit }` as the offset envelope. Anything else (a
 * chart's payload, a plain `{ rows }` table) is returned as the provider gave it.
 */
export function fromProviderResult(result: unknown, wire: TableWire): unknown {
  if (wire.paged === null || result === null || typeof result !== 'object') return result;
  const { rows, total, page, limit } = result as {
    rows?: unknown;
    total?: unknown;
    page?: unknown;
    limit?: unknown;
  };
  if (!Array.isArray(rows) || typeof total !== 'number') return result;
  const offset: OffsetPage<unknown> = offsetPage(rows, {
    total,
    page: typeof page === 'number' ? page : wire.paged.page,
    size: typeof limit === 'number' ? limit : wire.paged.size,
  });
  return offset;
}
