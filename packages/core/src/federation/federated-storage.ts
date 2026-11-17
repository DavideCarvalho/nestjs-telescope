// packages/core/src/federation/federated-storage.ts
//
// The store of a federated console: this app's own store, plus the stores other apps' telescopes
// write, read in place. Inside a console call's federation scope, reads go to the stores the call
// selected (one app: that store alone; several: fanned out and merged). Writes, pruning, leases
// and every read made outside a console call only touch this app's own store.
import { Logger } from '@nestjs/common';
import type { Entry } from '../entry/entry.js';
import {
  type RollupBucket,
  type RollupDelta,
  type RollupStore,
  mergeHistograms,
} from '../rollup/rollup-store.js';
import { decodeCursor, encodeCursor } from '../storage/cursor.js';
import type {
  BoundedPruneResult,
  BoundedPruneScope,
  EntryAggregateResult,
  EntryAggregation,
  EntryQuery,
  EntryWithBatch,
  Page,
  PruneScope,
  StorageProvider,
  TagCount,
  TagQuery,
} from '../storage/storage-provider.js';
import {
  type TenantView,
  activeTenantView,
  openTenantView,
  withTenantView,
  withoutTenantView,
} from '../storage/tenant-scoped-storage.js';
import type { FederatedStorageSource } from './config.js';
import { activeFederationScope } from './scope.js';

const logger = new Logger('TelescopeFederation');

/** A member of one read: its key in a merged cursor (`''` for this app), store and view. */
interface Member {
  key: string;
  app: string | null;
  store: StorageProvider;
  view: TenantView | null;
}

const DEFAULT_LIMIT = 50;
/** This app's store's optional maintenance methods, passed through. */
type OwnCapability =
  | 'pruneScoped'
  | 'pruneScopedBatch'
  | 'tryAcquireLease'
  | 'releaseLease'
  | 'markFamilySeen';
/** Optional reads: offered when every store a read goes to offers them. */
const READ_CAPABILITIES = new Set(['aggregate', 'queryRollups']);
/** Every optional method, hidden when not offered. */
const OPTIONAL = new Set([
  ...READ_CAPABILITIES,
  'recordRollups',
  'pruneScoped',
  'pruneScopedBatch',
  'tryAcquireLease',
  'releaseLease',
  'markFamilySeen',
]);
/** How many times one merged page reads a store that keeps answering empty (filtered) pages. */
const MAX_READS_PER_STORE = 8;
const MERGED_CURSOR_PREFIX = 'fed.';

/** Positions of a merged list: each store's own cursor (`null`: read to the end; absent: not started). */
type Positions = Record<string, string | null>;

/**
 * A merged list's cursor. It is a storage cursor (`encodeCursor`) whose id carries every store's
 * position, so `GET entries` accepts it like any other and each store resumes from its own place.
 */
export function encodeMergedCursor(atMs: number, positions: Positions): string {
  const packed = Buffer.from(JSON.stringify(positions)).toString('base64url');
  return encodeCursor(atMs, `${MERGED_CURSOR_PREFIX}${packed}`);
}

/** The positions of a merged cursor, or `null` for any other cursor. */
export function decodeMergedCursor(cursor: string): Positions | null {
  const decoded = decodeCursor(cursor);
  if (decoded === null || !decoded.id.startsWith(MERGED_CURSOR_PREFIX)) return null;
  try {
    const raw = Buffer.from(decoded.id.slice(MERGED_CURSOR_PREFIX.length), 'base64url').toString(
      'utf8',
    );
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const positions: Positions = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value === null || typeof value === 'string') positions[key] = value;
    }
    return positions;
  } catch {
    return null;
  }
}

/** Newest first, ties by id descending: the order every merged list uses. */
function newer(a: Entry, b: Entry): boolean {
  const at = a.createdAt.getTime();
  const bt = b.createdAt.getTime();
  return at !== bt ? at > bt : a.id > b.id;
}

/** Runs `fn` with `view` as the active view (`null`: unfiltered). */
function inView<T>(view: TenantView | null, fn: () => Promise<T>): Promise<T> {
  return withTenantView(view, fn);
}

/** Reads a property of `store` as it is inside `view` (scoped stores hide some inside a view). */
function peek<T>(view: TenantView | null, read: () => T): T {
  if (view === null) return withoutTenantView(read);
  const handle = openTenantView(view);
  try {
    return handle.run(read);
  } finally {
    handle.close();
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Merges the rows of one aggregation answered by several stores. */
export function mergeAggregates(
  request: EntryAggregation,
  results: EntryAggregateResult[],
): EntryAggregateResult {
  switch (request.kind) {
    case 'count': {
      const rows = new Map<string, { type: string; bucket: number | null; count: number }>();
      for (const result of results) {
        if (result.kind !== 'count') continue;
        for (const row of result.rows) {
          const key = `${row.type}\u0000${row.bucket ?? ''}`;
          const seen = rows.get(key);
          if (seen) seen.count += row.count;
          else rows.set(key, { ...row });
        }
      }
      return { kind: 'count', rows: [...rows.values()] };
    }
    case 'slowest': {
      const rows = results
        .flatMap((result) => (result.kind === 'slowest' ? result.rows : []))
        .sort((a, b) => b.durationMs - a.durationMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, request.limit);
      return { kind: 'slowest', rows };
    }
    case 'families': {
      // Counts and sums add up exactly. Quantiles do not: a family found in several stores gets
      // the duration-weighted mean of each store's quantile (an estimate; exact within one store).
      type Row = Extract<EntryAggregateResult, { kind: 'families' }>['rows'][number];
      const rows = new Map<string, { row: Row; weighted: number[] }>();
      for (const result of results) {
        if (result.kind !== 'families') continue;
        for (const row of result.rows) {
          const key = `${row.type}\u0000${row.familyHash}`;
          const seen = rows.get(key);
          const weighted = row.quantiles.map((q) => q * row.durationCount);
          if (!seen) {
            rows.set(key, { row: { ...row, quantiles: [...row.quantiles] }, weighted });
            continue;
          }
          seen.row.count += row.count;
          seen.row.durationCount += row.durationCount;
          seen.row.durationSum += row.durationSum;
          seen.weighted = seen.weighted.map((sum, index) => sum + (weighted[index] ?? 0));
        }
      }
      return {
        kind: 'families',
        rows: [...rows.values()].map(({ row, weighted }) => ({
          ...row,
          quantiles:
            row.durationCount > 0
              ? weighted.map((sum) => sum / row.durationCount)
              : row.quantiles.map(() => 0),
        })),
      };
    }
    case 'batchFamilies': {
      const rows = new Map<
        string,
        { batchId: string; familyHash: string; count: number; durationSum: number }
      >();
      for (const result of results) {
        if (result.kind !== 'batchFamilies') continue;
        for (const row of result.rows) {
          const key = `${row.batchId}\u0000${row.familyHash}`;
          const seen = rows.get(key);
          if (seen) {
            seen.count += row.count;
            seen.durationSum += row.durationSum;
          } else rows.set(key, { ...row });
        }
      }
      return { kind: 'batchFamilies', rows: [...rows.values()] };
    }
    case 'tagSets': {
      const rows = new Map<string, { tags: string[]; count: number; durationSum: number }>();
      for (const result of results) {
        if (result.kind !== 'tagSets') continue;
        for (const row of result.rows) {
          const key = JSON.stringify(row.tags);
          const seen = rows.get(key);
          if (seen) {
            seen.count += row.count;
            seen.durationSum += row.durationSum;
          } else rows.set(key, { ...row, tags: [...row.tags] });
        }
      }
      return { kind: 'tagSets', rows: [...rows.values()] };
    }
  }
}

/** Sums rollup buckets of the same metric and minute answered by several stores. */
export function mergeRollups(buckets: RollupBucket[]): RollupBucket[] {
  const merged = new Map<string, RollupBucket>();
  for (const bucket of buckets) {
    const key = `${bucket.metric}\u0000${bucket.bucketStart}`;
    const seen = merged.get(key);
    if (!seen) {
      merged.set(key, { ...bucket, histogram: mergeHistograms([], bucket.histogram) });
      continue;
    }
    seen.count += bucket.count;
    seen.sum += bucket.sum;
    seen.max = Math.max(seen.max, bucket.max);
    seen.histogram = mergeHistograms(seen.histogram, bucket.histogram);
  }
  return [...merged.values()];
}

interface MergeState {
  member: Member;
  /** Where the next read of this store starts (`undefined`: its first page). */
  position: string | undefined;
  /** Read to the end, and nothing left in `buffer`. */
  done: boolean;
  /** Rows read and not yet taken, newest first. */
  buffer: Entry[];
  /** The store's cursor after the rows in `buffer`. */
  bufferNext: string | null;
  reads: number;
  /** Could not be read on this page: left out of it, kept at its position. */
  failed: boolean;
}

/**
 * A {@link StorageProvider} over this app's store (`home`) and the federated apps' stores. Inside a
 * console call's federation scope it reads the stores the call selected; elsewhere it is `home`.
 */
export class FederatedStorage implements StorageProvider {
  private readonly sources = new Map<string, FederatedStorageSource>();
  private readonly resolved = new Map<string, Promise<StorageProvider>>();
  /** Stores already built, for a sync capability check. */
  private readonly built = new Map<string, StorageProvider>();

  constructor(
    private readonly home: StorageProvider,
    apps: { name: string; storage: FederatedStorageSource }[],
    /** Wraps each app's store as this app's own is (telescope work, organization scoping). */
    private readonly wrap: (storage: StorageProvider) => StorageProvider = (storage) => storage,
  ) {
    for (const app of apps) this.sources.set(app.name, app.storage);
    // The optional capabilities are there only when the stores a read goes to offer them.
    // biome-ignore lint/correctness/noConstructorReturn: capability presence is per call
    return new Proxy(this, {
      get(target, prop) {
        if (typeof prop === 'string' && OPTIONAL.has(prop) && !target.offers(prop)) {
          return undefined;
        }
        return Reflect.get(target, prop, target);
      },
    });
  }

  /**
   * Whether an optional capability is offered now: outside a console call, as this app's store
   * offers it; inside, when every store of the call does, through its view (the maintenance ones
   * are this app's alone).
   */
  private offers(prop: string): boolean {
    const own = typeof Reflect.get(this.home, prop) === 'function';
    if (!READ_CAPABILITIES.has(prop)) return own;
    const members = this.syncMembers();
    if (members === null) return own;
    return (
      members.length > 0 &&
      members.every(
        (member) => typeof peek(member.view, () => Reflect.get(member.store, prop)) === 'function',
      )
    );
  }

  /** The federated apps' names, in declaration order. */
  get appNames(): string[] {
    return [...this.sources.keys()];
  }

  /** A federated app's store, built (and initialized) on first use. */
  private storeOf(app: string): Promise<StorageProvider> {
    const cached = this.resolved.get(app);
    if (cached) return cached;
    const source = this.sources.get(app);
    if (source === undefined) return Promise.reject(new Error(`unknown federated app "${app}"`));
    const pending = (async () => {
      const raw = typeof source === 'function' ? await source() : source;
      await raw.init?.();
      const store = this.wrap(raw);
      this.built.set(app, store);
      return store;
    })();
    // A store that failed to come up is built again on the next read.
    pending.catch(() => this.resolved.delete(app));
    this.resolved.set(app, pending);
    return pending;
  }

  /** The stores the running console call reads; `null` outside a federation scope (`home` only). */
  private async members(): Promise<Member[] | null> {
    const scope = activeFederationScope();
    if (scope === null) return null;
    const active = activeTenantView();
    const members: Member[] = [];
    for (const member of scope.members) {
      // The call's own view: each store through its member view. Another one (a read across the
      // apps of an organization, or none at all): that view, on every store of the call.
      const view = active === scope.view ? member.view : active;
      if (member.app === null) {
        members.push({ key: '', app: null, store: this.home, view });
        continue;
      }
      try {
        members.push({
          key: member.app,
          app: member.app,
          store: await this.storeOf(member.app),
          view,
        });
      } catch (error) {
        // An app whose store cannot be built is left out of the read, as if it held nothing.
        logger.warn(`federated app "${member.app}" could not be read: ${errorText(error)}`);
      }
    }
    return members;
  }

  /** The members' stores, for a sync capability check (built stores only). */
  private syncMembers(): Member[] | null {
    const scope = activeFederationScope();
    if (scope === null) return null;
    const active = activeTenantView();
    const members: Member[] = [];
    for (const member of scope.members) {
      const view = active === scope.view ? member.view : active;
      if (member.app === null) {
        members.push({ key: '', app: null, store: this.home, view });
        continue;
      }
      const built = this.built.get(member.app);
      // Not built yet: no capability can be promised for it; the reads fall back to `get`.
      if (built === undefined) return [];
      members.push({ key: member.app, app: member.app, store: built, view });
    }
    return members;
  }

  /** Reads `fn` from each member; a failing federated store is skipped and reported. */
  private async fanOut<T>(
    members: Member[],
    fn: (member: Member) => Promise<T>,
  ): Promise<{ results: T[]; failed: boolean }> {
    const settled = await Promise.allSettled(
      members.map((member) => inView(member.view, () => fn(member))),
    );
    const results: T[] = [];
    let failed = false;
    settled.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
        return;
      }
      const member = members[index];
      // This app's own store failing fails the read, as it would without federation.
      if (member?.app == null) throw outcome.reason;
      failed = true;
      logger.warn(`federated app "${member.app}" could not be read: ${errorText(outcome.reason)}`);
    });
    return { results, failed };
  }

  // ── Writes and maintenance: this app's own store ──────────────────────────────

  store(entries: Entry[]): Promise<void> {
    return this.home.store(entries);
  }

  update(id: string, patch: Partial<Entry>): Promise<void> {
    return this.home.update(id, patch);
  }

  prune(olderThan: Date, keepLast?: number): Promise<number> {
    return this.home.prune(olderThan, keepLast);
  }

  clear(): Promise<void> {
    return this.home.clear();
  }

  pruneScoped(input: PruneScope): Promise<number> {
    return this.ownCapability('pruneScoped')(input);
  }

  pruneScopedBatch(input: BoundedPruneScope): Promise<BoundedPruneResult> {
    return this.ownCapability('pruneScopedBatch')(input);
  }

  tryAcquireLease(key: string, owner: string, ttlMs: number, nowMs: number): Promise<boolean> {
    return this.ownCapability('tryAcquireLease')(key, owner, ttlMs, nowMs);
  }

  releaseLease(key: string, owner: string): Promise<void> {
    return this.ownCapability('releaseLease')(key, owner);
  }

  markFamilySeen(familyHash: string, nowMs: number, windowMs: number): Promise<boolean> {
    return this.ownCapability('markFamilySeen')(familyHash, nowMs, windowMs);
  }

  recordRollups(deltas: RollupDelta[]): Promise<void> {
    const fn = (this.home as Partial<RollupStore>).recordRollups;
    if (fn === undefined) return Promise.reject(new Error('this store keeps no rollups'));
    return fn.call(this.home, deltas);
  }

  /** This app's store's own optional method, bound (the proxy hides it when absent). */
  private ownCapability<K extends OwnCapability>(name: K): NonNullable<StorageProvider[K]> {
    const fn = this.home[name] as ((...args: unknown[]) => unknown) | undefined;
    if (fn === undefined) throw new Error(`this store does not offer ${name}`);
    return ((...args: unknown[]) => fn.apply(this.home, args)) as NonNullable<StorageProvider[K]>;
  }

  /** Boots this app's store, then the federated ones (one that fails is retried on first read). */
  async init(): Promise<void> {
    await this.home.init?.();
    await Promise.all(
      this.appNames.map(async (app) => {
        try {
          await this.storeOf(app);
        } catch (error) {
          logger.warn(`federated app "${app}" is not reachable yet: ${errorText(error)}`);
        }
      }),
    );
  }

  async close(): Promise<void> {
    const stores = await Promise.allSettled([...this.resolved.values()]);
    for (const outcome of stores) {
      if (outcome.status === 'fulfilled') await outcome.value.close?.();
    }
    await this.home.close?.();
  }

  // ── Reads ─────────────────────────────────────────────────────────────────────

  async find(id: string): Promise<EntryWithBatch | null> {
    const members = await this.members();
    if (members === null) return this.home.find(id);
    for (const member of members) {
      try {
        const found = await inView(member.view, () => member.store.find(id));
        if (found !== null) return found;
      } catch (error) {
        if (member.app === null) throw error;
        logger.warn(`federated app "${member.app}" could not be read: ${errorText(error)}`);
      }
    }
    return null;
  }

  /**
   * The federated app whose store holds entry `id` within the running call (`null`: this app's
   * own store, or not found). For actions that run in the app's process (replay, EXPLAIN).
   */
  async federatedAppOf(id: string): Promise<string | null> {
    const members = await this.members();
    if (members === null) return null;
    for (const member of members) {
      const found = await inView(member.view, () => member.store.find(id)).catch(() => null);
      if (found !== null) return member.app;
    }
    return null;
  }

  async batch(batchId: string): Promise<Entry[]> {
    const members = await this.members();
    if (members === null) return this.home.batch(batchId);
    const { results } = await this.fanOut(members, (member) => member.store.batch(batchId));
    return results.flat().sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async tags(prefix?: string, query?: TagQuery): Promise<TagCount[]> {
    const members = await this.members();
    if (members === null) return this.home.tags(prefix, query);
    if (members.length === 1) {
      const [only] = members as [Member];
      return inView(only.view, () => only.store.tags(prefix, query));
    }
    // Each store's top `offset + limit`, summed: a tag just below one store's cut counts less.
    const offset = query?.offset ?? 0;
    const asked: TagQuery = {
      ...(query?.search !== undefined ? { search: query.search } : {}),
      ...(query?.recent !== undefined ? { recent: query.recent } : {}),
      ...(query?.limit !== undefined ? { limit: offset + query.limit } : {}),
    };
    const { results } = await this.fanOut(members, (member) => member.store.tags(prefix, asked));
    const counts = new Map<string, number>();
    for (const rows of results) {
      for (const row of rows) counts.set(row.tag, (counts.get(row.tag) ?? 0) + row.count);
    }
    const sorted = [...counts]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    return query?.limit !== undefined
      ? sorted.slice(offset, offset + query.limit)
      : sorted.slice(offset);
  }

  async get(query: EntryQuery): Promise<Page<Entry>> {
    const members = await this.members();
    if (members === null) return this.home.get(query);
    if (members.length === 0) return { data: [], nextCursor: null };
    const positions = query.cursor !== undefined ? decodeMergedCursor(query.cursor) : null;
    const startOf = (member: Member): string | null | undefined =>
      positions === null ? query.cursor : positions[member.key];
    if (members.length === 1) {
      const [only] = members as [Member];
      const start = startOf(only);
      if (start === null) return { data: [], nextCursor: null };
      const { cursor: _cursor, ...rest } = query;
      return inView(only.view, () =>
        only.store.get(start !== undefined ? { ...rest, cursor: start } : rest),
      );
    }
    return this.mergedPage(members, query, startOf);
  }

  /**
   * One page of several stores' entries, newest first. Each store is read from its own position
   * and only rows that are newer than everything another store may still hold are taken, so the
   * page is in order; the cursor keeps every store's position, so nothing repeats or is skipped.
   */
  private async mergedPage(
    members: Member[],
    query: EntryQuery,
    startOf: (member: Member) => string | null | undefined,
  ): Promise<Page<Entry>> {
    const limit =
      query.limit !== undefined && Number.isInteger(query.limit) && query.limit > 0
        ? query.limit
        : DEFAULT_LIMIT;
    const { cursor: _cursor, ...rest } = query;
    const states: MergeState[] = members.map((member) => {
      const start = startOf(member);
      return {
        member,
        position: start ?? undefined,
        done: start === null,
        buffer: [],
        bufferNext: null,
        reads: 0,
        failed: false,
      };
    });
    let partial = false;
    const out: Entry[] = [];

    /** Reads the next page of each store in `waiting`. */
    const refill = async (waiting: MergeState[]): Promise<void> => {
      await Promise.all(
        waiting.map(async (state) => {
          state.reads += 1;
          const { member } = state;
          try {
            const page = await inView(member.view, () =>
              member.store.get(
                state.position !== undefined
                  ? { ...rest, cursor: state.position, limit }
                  : { ...rest, limit },
              ),
            );
            if (page.partial) partial = true;
            state.buffer = [...page.data];
            state.bufferNext = page.nextCursor;
            if (page.data.length === 0) {
              // Nothing kept on this page (a scoped store filtered it): skip past it.
              if (page.nextCursor === null) state.done = true;
              else state.position = page.nextCursor;
            }
          } catch (error) {
            if (member.app === null) throw error;
            logger.warn(`federated app "${member.app}" could not be read: ${errorText(error)}`);
            // Left out of this page, at its position: the next page reads it again.
            state.failed = true;
            partial = true;
          }
        }),
      );
    };

    while (out.length < limit) {
      const live = states.filter((state) => !state.done && !state.failed);
      if (live.length === 0) break;
      const waiting = live.filter((state) => state.buffer.length === 0);
      if (waiting.length > 0) {
        // A store that may not be read again on this page may still hold newer rows: stop here.
        if (waiting.some((state) => state.reads >= MAX_READS_PER_STORE)) break;
        await refill(waiting);
        continue;
      }
      let head: MergeState | undefined;
      for (const state of live) {
        const first = state.buffer[0];
        const best = head?.buffer[0];
        if (first !== undefined && (best === undefined || newer(first, best))) head = state;
      }
      if (head === undefined) break;
      const entry = head.buffer.shift() as Entry;
      out.push(entry);
      if (head.buffer.length > 0) {
        head.position = encodeCursor(entry.createdAt.getTime(), entry.id);
      } else if (head.bufferNext === null) {
        head.done = true;
      } else {
        head.position = head.bufferNext;
      }
    }

    // Only stores that failed are left: the list ends here (and says it is partial).
    const finished = states.every((state) => state.done || state.failed);
    if (finished) return { data: out, nextCursor: null, ...(partial ? { partial } : {}) };
    const next: Positions = {};
    for (const state of states) {
      if (state.done) next[state.member.key] = null;
      else if (state.position !== undefined) next[state.member.key] = state.position;
    }
    const last = out.at(-1);
    return {
      data: out,
      nextCursor: encodeMergedCursor(last ? last.createdAt.getTime() : Date.now(), next),
      ...(partial ? { partial } : {}),
    };
  }

  /**
   * Window aggregation (offered when every store the call reads offers it, inside its view): one
   * store answers alone, several are merged.
   */
  async aggregate(request: EntryAggregation): Promise<EntryAggregateResult> {
    const members = await this.members();
    if (members === null) return this.ownRead('aggregate', request);
    const results = await Promise.all(
      members.map((member) =>
        inView(member.view, async () => {
          const fn = member.store.aggregate;
          if (fn === undefined) throw new Error('the store does not offer aggregate');
          return fn.call(member.store, request);
        }),
      ),
    );
    return results.length === 1
      ? (results[0] as EntryAggregateResult)
      : mergeAggregates(request, results);
  }

  /** Rollups (offered when every store the call reads offers them), summed per minute. */
  async queryRollups(
    metrics: string[],
    fromBucket: number,
    toBucket: number,
  ): Promise<RollupBucket[]> {
    const members = await this.members();
    const read = (store: StorageProvider) => (store as Partial<RollupStore>).queryRollups;
    if (members === null) {
      const fn = read(this.home);
      if (fn === undefined) throw new Error('this store keeps no rollups');
      return fn.call(this.home, metrics, fromBucket, toBucket);
    }
    const results = await Promise.all(
      members.map((member) =>
        inView(member.view, async () => {
          const fn = read(member.store);
          if (fn === undefined) throw new Error('the store keeps no rollups');
          return fn.call(member.store, metrics, fromBucket, toBucket);
        }),
      ),
    );
    return results.length === 1 ? (results[0] as RollupBucket[]) : mergeRollups(results.flat());
  }

  private ownRead(name: 'aggregate', request: EntryAggregation): Promise<EntryAggregateResult> {
    const fn = this.home[name];
    if (fn === undefined) return Promise.reject(new Error(`this store does not offer ${name}`));
    return fn.call(this.home, request);
  }
}

/** Whether `storage` is a {@link FederatedStorage}. */
export function isFederatedStorage(storage: unknown): storage is FederatedStorage {
  return storage instanceof FederatedStorage;
}
