import { Inject, Injectable, Optional } from '@nestjs/common';
import { type Entry, EntryType } from '../entry/entry.js';
import { TELESCOPE_STORAGE } from '../nest/telescope.options.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { DEFAULT_SCAN_CAP, collectEntriesInWindow } from './collect-window.js';
import { type TraceSummary, summarizeTraces } from './traces.js';
import { type Waterfall, buildWaterfall } from './waterfall.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
/** The walk's first page is `(size + 1) * 20` entries within these bounds; each next one doubles. */
const WALK_MIN_PAGE = 200;
const WALK_MAX_PAGE = 5000;
/** Traces hydrated at once. */
const HYDRATE_CONCURRENCY = 8;
/** Entries read per trace at most (a trace past it is summarized from its newest ones). */
const TRACE_ENTRY_CAP = 5000;

export interface TracesQuery {
  windowMs: number;
  limit?: number;
  /**
   * The `nextCursor` of the previous page: the traces after its last one, most recently active
   * first. Opaque; an invalid one throws {@link InvalidTracesCursor}.
   */
  cursor?: string;
}

export interface TracesServiceOptions {
  pageSize?: number;
  scanCap?: number;
}

export interface TracesResult {
  traces: TraceSummary[];
  /** Entries read for this page (the walk, then the page's traces). */
  scanned: number;
  /**
   * The walk stopped at the scan cap before it had a full page (a window with few traces among
   * many untraced entries): the page holds the traces it could confirm.
   */
  truncated: boolean;
  /** The cursor of the next page, or `null` on the last one. */
  nextCursor: string | null;
  hasNext: boolean;
}

/** An undecodable `cursor` (a 400 for the HTTP API). */
export class InvalidTracesCursor extends Error {
  constructor() {
    super('Invalid traces cursor.');
    this.name = 'InvalidTracesCursor';
  }
}

/** The last trace of a page: where the next one starts. */
interface TraceKey {
  traceId: string;
  /** Epoch ms of its newest entry. */
  lastAt: number;
}

/** Most recently active first, then the larger trace id: the traces list order. */
function compareKeys(a: TraceKey, b: TraceKey): number {
  if (a.lastAt !== b.lastAt) return b.lastAt - a.lastAt;
  return a.traceId < b.traceId ? 1 : a.traceId > b.traceId ? -1 : 0;
}

/** Whether `key` sorts after `cursor` (belongs to a later page). */
function isAfter(key: TraceKey, cursor: TraceKey): boolean {
  return compareKeys(cursor, key) < 0;
}

export function encodeTracesCursor(key: TraceKey): string {
  return Buffer.from(JSON.stringify(['t', key.lastAt, key.traceId])).toString('base64url');
}

export function decodeTracesCursor(cursor: string): TraceKey {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidTracesCursor();
  }
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value[0] !== 't' ||
    !Number.isSafeInteger(value[1]) ||
    typeof value[2] !== 'string' ||
    value[2] === ''
  ) {
    throw new InvalidTracesCursor();
  }
  return { lastAt: value[1] as number, traceId: value[2] as string };
}

/**
 * Lists the window's distinct traces, most recently active first, a page at a time, from the
 * store's newest-first `get` — content-less, mirroring TimeseriesService.
 *
 * Keyset, not a grouping of the window: the entries are walked newest-first (from the cursor's
 * trace down) only until the page's traces are known — the first time a trace shows up in that
 * walk is its newest entry — and one more trace tells whether a next page exists. Only the page's
 * traces are then read in full (by `traceId`), so a page costs about the entries its traces hold,
 * on the first page and on the hundredth, instead of up to `scanCap` entries of the window.
 */
@Injectable()
export class TracesService {
  private readonly scanCap: number;

  constructor(
    @Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider,
    @Optional() options?: TracesServiceOptions,
  ) {
    this.scanCap = options?.scanCap ?? DEFAULT_SCAN_CAP;
  }

  async getTraces(query: TracesQuery): Promise<TracesResult> {
    if (!Number.isFinite(query.windowMs) || query.windowMs <= 0) {
      throw new RangeError(`windowMs must be a positive, finite number (got ${query.windowMs}).`);
    }
    const size = Math.min(MAX_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)));
    const cursor = query.cursor !== undefined ? decodeTracesCursor(query.cursor) : undefined;
    const windowStart = new Date(Date.now() - query.windowMs);

    /** Traces met in the walk (their first entry there is the newest at or below the cursor). */
    const met = new Map<string, number>();
    /** Met traces not yet read, ordered. */
    let pending: TraceKey[] = [];
    /** Read traces that belong on this page or after it, ordered, with their entries. */
    const kept: { key: TraceKey; entries: Entry[] }[] = [];
    let scanned = 0;
    let walkCursor: string | undefined;
    /** The `createdAt` of the last entry walked: every trace not met yet is no newer. */
    let position = Number.POSITIVE_INFINITY;
    /** The walk reached the window's end: nothing is left to meet. */
    let exhausted = false;
    /** The walk stopped (at the end, or at the scan cap). */
    let walked = false;
    let truncated = false;
    let pageSize = Math.min(WALK_MAX_PAGE, Math.max(WALK_MIN_PAGE, (size + 1) * 20));

    const confirmed = (key: TraceKey) => exhausted || key.lastAt > position;

    for (;;) {
      if (!walked) {
        const page = await this.storage.get({
          after: windowStart,
          // At or below the cursor's millisecond (`before` is exclusive).
          ...(cursor !== undefined ? { before: new Date(cursor.lastAt + 1) } : {}),
          omitContent: true,
          limit: pageSize,
          ...(walkCursor !== undefined ? { cursor: walkCursor } : {}),
        });
        for (const entry of page.data) {
          scanned += 1;
          position = entry.createdAt.getTime();
          const traceId = entry.traceId;
          if (traceId === null || met.has(traceId)) continue;
          met.set(traceId, position);
          const key = { traceId, lastAt: position };
          // At the cursor's millisecond, only a smaller id comes after it.
          if (cursor !== undefined && !isAfter(key, cursor)) continue;
          pending.push(key);
        }
        exhausted =
          page.data.length === 0 || page.nextCursor === null || page.nextCursor === walkCursor;
        walkCursor = page.nextCursor ?? undefined;
        walked = exhausted;
        // The cap: what was not walked may hold traces, so only those newer than the position
        // are placed.
        if (!exhausted && scanned >= this.scanCap) {
          truncated = true;
          walked = true;
        }
        pageSize = Math.min(WALK_MAX_PAGE, pageSize * 2);
        pending.sort(compareKeys);
      }

      // Read the met traces in order until the page and one more are known (or none is left).
      while (kept.length <= size && pending.length > 0) {
        const next = pending.slice(0, HYDRATE_CONCURRENCY);
        // A trace whose newest entry is not yet below the walk could still be passed by an unmet
        // one: wait for the walk.
        const ready = next.filter((key) => confirmed(key));
        if (ready.length === 0) break;
        pending = pending.slice(ready.length);
        const read = await Promise.all(ready.map((key) => this.traceEntries(key, windowStart)));
        for (const trace of read) {
          scanned += trace.entries.length;
          // A trace with an entry newer than the cursor sorts before it: an earlier page shows it
          // (or it became active again, and the first page shows it now).
          if (cursor !== undefined && !isAfter(trace.key, cursor)) continue;
          kept.push(trace);
        }
        kept.sort((a, b) => compareKeys(a.key, b.key));
      }

      // Every kept trace was confirmed when read (and stays so: the position only goes down).
      if (kept.length > size) break;
      if (walked && pending.every((key) => !confirmed(key))) break;
    }

    const page = kept.slice(0, size);
    // Past the cap there may be more: the next page walks on from this one's last trace.
    const hasNext = kept.length > size || (truncated && page.length > 0);
    const last = page[page.length - 1];
    const traces = summarizeTraces(await this.withRequestContent(page.flatMap((t) => t.entries)), {
      limit: page.length,
    });
    // The page keeps the order the cursor follows (ties by trace id).
    const order = new Map(page.map((trace, index) => [trace.key.traceId, index]));
    traces.sort((a, b) => (order.get(a.traceId) ?? 0) - (order.get(b.traceId) ?? 0));
    return {
      traces,
      scanned,
      truncated,
      nextCursor: hasNext && last !== undefined ? encodeTracesCursor(last.key) : null,
      hasNext: hasNext && last !== undefined,
    };
  }

  /** One trace's entries in the window (content-less), and its key from them. */
  private async traceEntries(
    key: TraceKey,
    windowStart: Date,
  ): Promise<{ key: TraceKey; entries: Entry[] }> {
    const { entries } = await collectEntriesInWindow(
      this.storage,
      { traceId: key.traceId, after: windowStart, omitContent: true },
      { pageSize: MAX_LIMIT, scanCap: TRACE_ENTRY_CAP },
    );
    let lastAt = key.lastAt;
    for (const entry of entries) lastAt = Math.max(lastAt, entry.createdAt.getTime());
    return { key: { traceId: key.traceId, lastAt }, entries };
  }

  /**
   * `entries` with the content of their request entries (the summary's "METHOD uri" label), read
   * in one batched `get` by id. Everything else stays content-less.
   */
  private async withRequestContent(entries: Entry[]): Promise<Entry[]> {
    const ids = entries.filter((entry) => entry.type === EntryType.Request).map((e) => e.id);
    if (ids.length === 0) return entries;
    const page = await this.storage.get({ ids, limit: ids.length });
    const content = new Map(page.data.map((entry) => [entry.id, entry.content]));
    return entries.map((entry) =>
      content.has(entry.id) ? { ...entry, content: content.get(entry.id) } : entry,
    );
  }

  /**
   * Build a nested span waterfall for ONE trace. Fetches the trace's entries WITH
   * content (labels need it) and reconstructs parent/child nesting from time-
   * interval containment — see {@link buildWaterfall}. Returns `null` when the
   * trace has no entries (e.g. unknown / pruned trace id).
   */
  async getWaterfall(traceId: string): Promise<Waterfall | null> {
    return buildWaterfall(await this.getTraceEntries(traceId));
  }

  /** The entries of one trace (up to 500), with content, as the store shows them to this call. */
  async getTraceEntries(traceId: string): Promise<Entry[]> {
    const page = await this.storage.get({ traceId, limit: MAX_LIMIT });
    return page.data;
  }
}
