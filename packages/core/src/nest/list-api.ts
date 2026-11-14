/**
 * Aviary list API helpers — shared copy.
 *
 * REFERENCE: the published, exported versions of these helpers live in the nestjs-filter repo
 * (https://github.com/DavideCarvalho/nestjs-filter, `packages/core/src/pagination/list-api.ts`,
 * exported by `@dudousxd/nestjs-filter` as `offsetPage`, `cursorPage`, `parsePageParams`,
 * `parseCursorParams`, `resolveSort`, `rejectUnknownParams` and `ListQueryError`). Libs keep this
 * copy instead of depending on nestjs-filter so their releases do not wait on it.
 *
 * RULE: copy this file VERBATIM into a lib's server package (e.g. `src/server/list-api.ts`).
 * Every Aviary lib carries the same bytes: never edit it in one repo only — change it everywhere
 * at once (and mirror generic fixes into nestjs-filter core).
 * Its only import is `BadRequestException` from `@nestjs/common`.
 *
 * Wire: offset paging `page` (1-based) + `size`; cursor paging `after`/`before` + `first`/`last`;
 * `sort=-createdAt,name`; `filter[field]=v`, `filter[field][op]=v`, `filter[field][]=a`,
 * `filter[field]=a,b`. Responses: `{ data, meta }` (see `OffsetPage` / `CursorPageResponse`).
 * Every rejection is a `ListQueryError` (a `BadRequestException`), so Nest answers 400.
 */
import { BadRequestException } from '@nestjs/common';

// ─── Errors ─────────────────────────────────────────────────────────────────

/**
 * A list request the endpoint cannot serve: a non-numeric or out-of-range `page`/`size`, a
 * malformed cursor, a sort field outside the endpoint's allow-list. Extends
 * `BadRequestException`, so an uncaught one becomes a 400 response.
 */
export class ListQueryError extends BadRequestException {
  constructor(message: string) {
    super(message);
    this.name = 'ListQueryError';
  }
}

// ─── Response envelopes ─────────────────────────────────────────────────────

/** The `meta` of an offset page. `currentPage`, `lastPage` and `firstPage` are 1-based. */
export interface OffsetPageMeta {
  total: number;
  perPage: number;
  currentPage: number;
  lastPage: number;
  firstPage: number;
}

/** An offset-paged list response: `{ data, meta: { total, perPage, currentPage, lastPage, firstPage } }`. */
export interface OffsetPage<T> {
  data: T[];
  meta: OffsetPageMeta;
}

/** The `meta` of a cursor page. A cursor is `null` when there is no page in that direction. */
export interface CursorPageMeta {
  nextCursor: string | null;
  prevCursor: string | null;
  hasNext: boolean;
  hasPrev: boolean;
}

/** A cursor-paged list response: `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }`. */
export interface CursorPageResponse<T> {
  data: T[];
  meta: CursorPageMeta;
}

/** What {@link offsetPage} needs besides the rows. */
export interface OffsetPageInit {
  /** Number of rows matching the request across every page. */
  total: number;
  /** The 1-based page these rows are. */
  page: number;
  /** The page size the rows were fetched with. */
  size: number;
}

/**
 * What {@link cursorPage} needs besides the rows. `hasNext` / `hasPrev` default to whether the
 * matching cursor is present.
 */
export interface CursorPageInit {
  nextCursor?: string | null;
  prevCursor?: string | null;
  hasNext?: boolean;
  hasPrev?: boolean;
}

const toCount = (n: number, min: number): number =>
  Number.isFinite(n) ? Math.max(min, Math.floor(n)) : min;

/**
 * Wraps one page of rows in the offset list envelope.
 *
 * ```ts
 * const { page, size } = parsePageParams(query, { defaultSize: 50, maxSize: 200 });
 * const [rows, total] = await repo.findAndCount({ skip: (page - 1) * size, take: size });
 * return offsetPage(rows, { total, page, size });
 * ```
 */
export function offsetPage<T>(data: T[], init: OffsetPageInit): OffsetPage<T> {
  const total = toCount(init.total, 0);
  const perPage = toCount(init.size, 1);
  return {
    data,
    meta: {
      total,
      perPage,
      currentPage: toCount(init.page, 1),
      lastPage: Math.max(1, Math.ceil(total / perPage)),
      firstPage: 1,
    },
  };
}

/**
 * Wraps one page of rows in the cursor list envelope, for a store that produces its own cursors.
 *
 * ```ts
 * return cursorPage(rows, { nextCursor, prevCursor: null });
 * ```
 */
export function cursorPage<T>(data: T[], init: CursorPageInit = {}): CursorPageResponse<T> {
  const nextCursor = init.nextCursor ?? null;
  const prevCursor = init.prevCursor ?? null;
  return {
    data,
    meta: {
      nextCursor,
      prevCursor,
      hasNext: init.hasNext ?? nextCursor !== null,
      hasPrev: init.hasPrev ?? prevCursor !== null,
    },
  };
}

// ─── Request params ─────────────────────────────────────────────────────────

/** Size policy shared by {@link parsePageParams} and {@link parseCursorParams}. */
export interface PageSizeOptions {
  /** Size used when the request sends none. Default `25`, capped at `maxSize`. */
  defaultSize?: number;
  /** Largest size a request may ask for; bigger values are clamped down. Default `100`. */
  maxSize?: number;
}

/** Offset paging params resolved by {@link parsePageParams}. `page` is 1-based. */
export interface PageParams {
  page: number;
  size: number;
  /** `(page - 1) * size`, ready for `OFFSET` / `skip`. */
  offset: number;
}

/** Options for {@link parseCursorParams}. */
export interface CursorParamsOptions<C> extends PageSizeOptions {
  /**
   * Validates and decodes the cursor. Return `null`/`undefined` (or throw) for a malformed
   * cursor and the request is rejected with a 400. Without it, any non-empty string is accepted.
   */
  decode?: (cursor: string) => C | null | undefined;
}

/** Cursor paging params resolved by {@link parseCursorParams}. */
export interface ParsedCursorParams<C = unknown> {
  /** Return the page after this cursor (forward). */
  after?: string;
  /** Return the page before this cursor (backward). */
  before?: string;
  /** Page size: `first` going forward, `last` going backward, clamped to `maxSize`. */
  size: number;
  /** True when paging backward (`before` given). */
  backward: boolean;
  /** The cursor `options.decode` returned, when a cursor was sent and a decoder given. */
  decoded?: C;
}

type Query = Record<string, unknown>;

function resolveSizePolicy(options: PageSizeOptions): { defaultSize: number; maxSize: number } {
  const maxSize = Math.max(1, Math.floor(options.maxSize ?? 100));
  const defaultSize = Math.min(maxSize, Math.max(1, Math.floor(options.defaultSize ?? 25)));
  return { defaultSize, maxSize };
}

/**
 * Reads a positive integer query param. Absent or empty → `undefined`; anything that is not a
 * whole number of at least 1 (junk, `0`, negatives, decimals, repeated params) → 400.
 */
function readPositiveInt(query: Query, key: string): number | undefined {
  const raw = query[key];
  if (raw === undefined || raw === null || raw === '') return undefined;
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : null;
  if (text === null || !/^\d+$/.test(text) || Number(text) < 1) {
    throw new ListQueryError(`Invalid "${key}": expected a whole number of at least 1.`);
  }
  const n = Number(text);
  if (!Number.isSafeInteger(n)) {
    throw new ListQueryError(`Invalid "${key}": expected a whole number of at least 1.`);
  }
  return n;
}

/** Reads an opaque cursor param. Absent or empty → `undefined`; not a single string → 400. */
function readCursor(query: Query, key: string): string | undefined {
  const raw = query[key];
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') {
    throw new ListQueryError(`Invalid "${key}": expected a single cursor string.`);
  }
  return raw;
}

/**
 * Reads offset paging params (`page`, `size`) from a decoded query object. `page` is 1-based and
 * defaults to 1; `size` defaults to `defaultSize` and is clamped down to `maxSize`. A value that
 * is not a whole number of at least 1 throws {@link ListQueryError} (400).
 *
 * ```ts
 * const { page, size, offset } = parsePageParams(query, { defaultSize: 50, maxSize: 200 });
 * ```
 */
export function parsePageParams(query: Query, options: PageSizeOptions = {}): PageParams {
  const policy = resolveSizePolicy(options);
  const page = readPositiveInt(query, 'page') ?? 1;
  const size = Math.min(policy.maxSize, readPositiveInt(query, 'size') ?? policy.defaultSize);
  return { page, size, offset: (page - 1) * size };
}

/**
 * Reads cursor paging params from a decoded query object: `after` / `before` (opaque cursors) and
 * `first` / `last` (sizes). The size is `first` going forward and `last` going backward (the
 * other one is used when only it is sent), `defaultSize` when absent, clamped down to `maxSize`.
 *
 * Throws {@link ListQueryError} (400) when both `after` and `before` are sent, when a size is not
 * a whole number of at least 1, or when `options.decode` rejects the cursor.
 *
 * ```ts
 * const { after, before, size } = parseCursorParams(query, { defaultSize: 50, decode: decodeMyCursor });
 * ```
 */
export function parseCursorParams<C = unknown>(
  query: Query,
  options: CursorParamsOptions<C> = {},
): ParsedCursorParams<C> {
  const policy = resolveSizePolicy(options);
  const after = readCursor(query, 'after');
  const before = readCursor(query, 'before');
  if (after !== undefined && before !== undefined) {
    throw new ListQueryError('Send either "after" or "before", not both.');
  }
  const first = readPositiveInt(query, 'first');
  const last = readPositiveInt(query, 'last');
  const backward = before !== undefined;
  const requested = backward ? (last ?? first) : (first ?? last);
  const result: ParsedCursorParams<C> = {
    size: Math.min(policy.maxSize, requested ?? policy.defaultSize),
    backward,
  };
  if (after !== undefined) result.after = after;
  if (before !== undefined) result.before = before;

  const cursor = after ?? before;
  if (cursor !== undefined && options.decode) {
    let decoded: C | null | undefined;
    try {
      decoded = options.decode(cursor);
    } catch {
      decoded = undefined;
    }
    if (decoded === null || decoded === undefined) {
      throw new ListQueryError(`Malformed cursor in "${backward ? 'before' : 'after'}".`);
    }
    result.decoded = decoded;
  }
  return result;
}

// ─── Unknown params ─────────────────────────────────────────────────────────

/**
 * Old list param names and what replaced them. `limit`/`perPage`/`pageSize` became `size` on offset
 * lists and `first` on cursor lists; the others have one replacement each.
 */
const LEGACY_PARAMS: Readonly<Record<string, readonly string[]>> = {
  limit: ['size', 'first'],
  perPage: ['size', 'first'],
  pageSize: ['size', 'first'],
  offset: ['page'],
  cursor: ['after'],
  next: ['after'],
  where: ['filter'],
  dir: ['sort'],
  q: ['search'],
};

const quoteList = (names: readonly string[]): string => names.map((n) => `"${n}"`).join(', ');

/**
 * Rejects every top-level query param the endpoint does not read, so a caller still on an old
 * wire (`?limit=5`, `?where[status]=x`, `?cursor=…`, a bare `?status=x`) gets a 400 instead of a
 * silently unfiltered or default-sized page. A key's name is the part before its first `[`, so
 * flat bracket keys (`filter[status][in]`) count as `filter`.
 *
 * The message names the replacement for the removed names: `limit` / `perPage` / `pageSize` →
 * `size` (offset) or `first` (cursor), `offset` → `page`, `cursor` / `next` → `after`, `where` →
 * `filter`, `dir` → `sort`, and a bare field → `filter[<field>]` when the endpoint takes `filter`.
 * `filter` and `sort` are accepted only when `allowed` lists them.
 *
 * ```ts
 * rejectUnknownParams(query, ['page', 'size', 'sort', 'filter', 'search']);
 * ```
 */
export function rejectUnknownParams(query: Query, allowed: readonly string[]): void {
  if (query === null || typeof query !== 'object') return;
  const known = new Set(allowed);
  for (const key of Object.keys(query)) {
    const bracket = key.indexOf('[');
    const name = bracket > 0 ? key.slice(0, bracket) : key;
    if (known.has(name)) continue;
    const accepted = allowed.length > 0 ? quoteList(allowed) : '(none)';
    const legacy = Object.prototype.hasOwnProperty.call(LEGACY_PARAMS, name)
      ? (LEGACY_PARAMS[name] as readonly string[])
      : undefined;
    let hint: string;
    if (legacy) {
      const usable = legacy.filter((r) => known.has(r));
      hint =
        usable.length > 0
          ? `"${name}" was removed; use ${usable.map((r) => `"${r}"`).join(' or ')} instead.`
          : `"${name}" was removed and this endpoint has no replacement for it.`;
    } else if (known.has('filter')) {
      hint = `Unknown query parameter "${name}"; to filter on a field use "filter[${name}]=…".`;
    } else {
      hint = `Unknown query parameter "${name}".`;
    }
    throw new ListQueryError(`${hint} Accepted parameters: ${accepted}.`);
  }
}

// ─── Sort ───────────────────────────────────────────────────────────────────

/** A sort directive whose field is one of the endpoint's sortable fields. */
export interface ResolvedSortItem<F extends string = string> {
  field: F;
  direction: 'asc' | 'desc';
}

/** Options for {@link resolveSort}. */
export interface ResolveSortOptions<F extends string> {
  /** The fields this endpoint can sort by. Anything else is rejected with a 400. */
  sortable: readonly F[];
  /** The order used when the request sends no sort: `'-createdAt'` or sort items. Default none. */
  default?: string | readonly ResolvedSortItem<F>[];
}

function parseSortTokens(raw: unknown): ResolvedSortItem[] {
  if (raw === undefined || raw === null || raw === '') return [];
  const tokens: string[] = [];
  const values = Array.isArray(raw) ? raw : [raw];
  for (const value of values) {
    if (typeof value === 'string') {
      tokens.push(...value.split(','));
    } else if (
      value !== null &&
      typeof value === 'object' &&
      typeof (value as { field?: unknown }).field === 'string' &&
      ((value as { direction?: unknown }).direction === 'asc' ||
        (value as { direction?: unknown }).direction === 'desc')
    ) {
      const item = value as ResolvedSortItem;
      tokens.push(`${item.direction === 'desc' ? '-' : ''}${item.field}`);
    } else {
      throw new ListQueryError('Invalid "sort": expected a list like "-createdAt,name".');
    }
  }
  const items: ResolvedSortItem[] = [];
  for (const token of tokens) {
    const trimmed = token.trim();
    const desc = trimmed.startsWith('-');
    const field = (desc ? trimmed.slice(1) : trimmed).trim();
    if (field.length === 0) continue;
    items.push({ field, direction: desc ? 'desc' : 'asc' });
  }
  return items;
}

/**
 * Checks a request's `sort` against the endpoint's sortable allow-list. Accepts the raw query
 * value (`'-createdAt,name'`, or repeated `sort` params) or already-parsed sort items. A leading
 * `-` means descending. Returns the default order when the request has no sort (absent or empty,
 * like `?sort=`), and throws {@link ListQueryError} (400) for a field outside `sortable`.
 *
 * The `default` order must use sortable fields too; one that does not throws a plain `Error` on
 * every call (a developer misconfiguration, not a bad request), so the typo surfaces at once.
 *
 * ```ts
 * const sort = resolveSort(query.sort, { sortable: ['createdAt', 'name'], default: '-createdAt' });
 * ```
 */
export function resolveSort<F extends string>(
  raw: unknown,
  options: ResolveSortOptions<F>,
): ResolvedSortItem<F>[] {
  const allowed = new Set<string>(options.sortable);
  const fallback = options.default === undefined ? [] : parseSortTokens(options.default);
  for (const item of fallback) {
    if (!allowed.has(item.field)) {
      const list = options.sortable.length > 0 ? options.sortable.join(', ') : '(none)';
      throw new Error(
        `resolveSort: the default sort field "${item.field}" is not sortable. Sortable fields: ${list}.`,
      );
    }
  }
  const items = parseSortTokens(raw);
  if (items.length === 0) return fallback as ResolvedSortItem<F>[];
  for (const item of items) {
    if (!allowed.has(item.field)) {
      const list = options.sortable.length > 0 ? options.sortable.join(', ') : '(none)';
      throw new ListQueryError(`Unknown sort field "${item.field}". Sortable fields: ${list}.`);
    }
  }
  return items as ResolvedSortItem<F>[];
}

// ─── Filter ─────────────────────────────────────────────────────────────────

/** Options for {@link parseFilterParams}: each filterable field and the operators it supports. */
export interface FilterParamsOptions<S extends Record<string, readonly string[]>> {
  /**
   * `{ status: ['eq', 'in'], createdAt: ['gte', 'lte'] }`. A bare `filter[field]=v` is operator
   * `eq`; a list (`filter[field]=a,b` or `filter[field][]=a`) is operator `in`, so list them
   * where the field accepts them.
   */
  fields: S;
}

/** One filter condition read by {@link parseFilterParams}. Values are the raw query strings. */
export type ParsedFilter<S extends Record<string, readonly string[]>> = {
  [K in keyof S & string]: { field: K; op: S[K][number]; value: string | string[] };
}[keyof S & string];

/** Operators whose value is a list: a comma-separated string is split for them. */
const LIST_OPERATORS = new Set(['in', 'notIn', 'nin', 'between', 'notBetween', 'isAnyOf']);

function filterError(message: string): ListQueryError {
  return new ListQueryError(`Invalid filter: ${message}`);
}

function readFilterStrings(where: string, value: unknown): string | string[] {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return item;
      if (typeof item === 'number' || typeof item === 'boolean') return String(item);
      throw filterError(`"${where}" must be a value or a list of values.`);
    });
  }
  throw filterError(`"${where}" must be a value or a list of values.`);
}

const splitList = (value: string): string[] =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

/**
 * Reads the `filter` params of a list request into a typed list of `{ field, op, value }`.
 * Accepts both an Express-parsed nested query (`{ filter: { status: 'open' } }`) and flat bracket
 * keys (`{ 'filter[status]': 'open' }`). Forms:
 *
 * | Wire | Result |
 * |---|---|
 * | `filter[status]=open` | `{ field: 'status', op: 'eq', value: 'open' }` |
 * | `filter[status]=open,closed` | `{ field: 'status', op: 'in', value: ['open', 'closed'] }` |
 * | `filter[status][]=open&filter[status][]=closed` | `{ field: 'status', op: 'in', value: ['open', 'closed'] }` |
 * | `filter[createdAt][gte]=2026-01-01` | `{ field: 'createdAt', op: 'gte', value: '2026-01-01' }` |
 * | `filter[id][in]=1,2` | `{ field: 'id', op: 'in', value: ['1', '2'] }` |
 *
 * A bare `filter[field]=` (empty) is skipped, so a cleared UI input sends no condition. An unknown
 * field, an operator the field does not support, a list on a single-value operator, or any other
 * `filter` shape throws {@link ListQueryError} (400). Values stay strings; coerce them per field.
 *
 * ```ts
 * const filters = parseFilterParams(query, {
 *   fields: { status: ['eq', 'in'], createdAt: ['gte', 'lte'] },
 * });
 * ```
 */
export function parseFilterParams<const S extends Record<string, readonly string[]>>(
  query: Query,
  options: FilterParamsOptions<S>,
): ParsedFilter<S>[] {
  const out: ParsedFilter<S>[] = [];
  const fieldNames = Object.keys(options.fields);

  const push = (field: string, op: string | undefined, raw: unknown, forceList: boolean) => {
    if (!Object.prototype.hasOwnProperty.call(options.fields, field)) {
      const list = fieldNames.length > 0 ? fieldNames.join(', ') : '(none)';
      throw filterError(`unknown field "${field}". Filterable fields: ${list}.`);
    }
    const where = op === undefined ? `filter[${field}]` : `filter[${field}][${op}]`;
    let value = readFilterStrings(where, raw);
    let resolvedOp = op;
    if (resolvedOp === undefined) {
      if (typeof value === 'string' && !forceList) {
        if (value === '') return;
        const parts = splitList(value);
        if (parts.length > 1) {
          resolvedOp = 'in';
          value = parts;
        } else {
          resolvedOp = 'eq';
          value = value.trim();
        }
      } else {
        resolvedOp = 'in';
        value = typeof value === 'string' ? [value] : value;
      }
    } else if (LIST_OPERATORS.has(resolvedOp)) {
      if (typeof value === 'string') value = splitList(value);
    } else if (Array.isArray(value) || forceList) {
      throw filterError(`"${where}" takes a single value, not a list.`);
    }
    const ops = options.fields[field] as readonly string[];
    if (!ops.includes(resolvedOp)) {
      const list = ops.length > 0 ? ops.join(', ') : '(none)';
      throw filterError(
        `operator "${resolvedOp}" is not supported on "${field}". Supported: ${list}.`,
      );
    }
    out.push({ field, op: resolvedOp, value } as ParsedFilter<S>);
  };

  // Express (`qs`) nested form: `{ filter: { field: v | v[] | { op: v | v[] } } }`.
  const nested = query.filter;
  if (nested !== undefined && nested !== null) {
    if (typeof nested !== 'object' || Array.isArray(nested)) {
      throw filterError('use filter[field]=value or filter[field][op]=value.');
    }
    for (const [field, value] of Object.entries(nested as Record<string, unknown>)) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        for (const [op, opValue] of Object.entries(value as Record<string, unknown>)) {
          if (op === '') push(field, undefined, opValue, true);
          else push(field, op, opValue, false);
        }
      } else {
        push(field, undefined, value, Array.isArray(value));
      }
    }
  }

  // Flat form (no nested query parser): `filter[field]`, `filter[field][]`, `filter[field][op]`,
  // `filter[field][op][]`.
  for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith('filter[')) continue;
    const match = /^filter\[([^[\]]+)\](?:\[([^[\]]+)\])?(\[\])?$/.exec(key);
    if (!match) throw filterError(`unsupported parameter "${key}".`);
    const [, field, op, brackets] = match as unknown as [
      string,
      string,
      string | undefined,
      string?,
    ];
    const list = brackets !== undefined || Array.isArray(value);
    if (op === undefined) push(field, undefined, value, list);
    else push(field, op, value, brackets !== undefined && !LIST_OPERATORS.has(op));
  }
  return out;
}
