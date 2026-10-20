import type {
  BoundedPruneResult,
  BoundedPruneScope,
  Entry,
  EntryQuery,
  EntryWithBatch,
  Page,
  PruneScope,
  RollupBucket,
  RollupDelta,
  StorageProvider,
  TagCount,
  TagQuery,
} from '@dudousxd/nestjs-telescope';
import { decodeCursor, encodeCursor, isRollupStore } from '@dudousxd/nestjs-telescope';
import { Logger } from '@nestjs/common';
import { type ParquetColdStore, dedupe } from './parquet-cold-store.js';
import { newestFirst } from './rows.js';

export interface TieredStorageOptions {
  /** Where entries are written and stay until the pruner archives them. Any `StorageProvider`. */
  hot: StorageProvider;
  cold: ParquetColdStore;
}

const DEFAULT_LIMIT = 50;
/** Hot pages fetched per call while skipping same-millisecond ties already returned. */
const MAX_HOT_PAGES = 20;

/**
 * One `StorageProvider` over a hot store and a Parquet cold tier.
 *
 * Writes, `update`, leases and `markFamilySeen` go to hot; so do the `prune*` calls, which then
 * run the cold tier's compaction and retention while the pruner still holds its lease. Reads
 * merge both tiers on the `(createdAt, id)` keyset, preferring the hot copy of an entry that is
 * briefly in both (archived, not yet deleted), so a page never repeats an entry and paging across
 * the boundary has no gap. A cold failure degrades to hot-only results rather than an error.
 *
 * Optional SPI members exist exactly when the hot store has them, so the pruner and the rollup
 * reader see the hot store's capabilities.
 */
export class TieredStorageProvider implements StorageProvider {
  readonly hot: StorageProvider;
  readonly cold: ParquetColdStore;
  private readonly logger = new Logger('TelescopeTieredStorage');
  private warnedColdFailure = false;

  pruneScoped?: (input: PruneScope) => Promise<number>;
  pruneScopedBatch?: (input: BoundedPruneScope) => Promise<BoundedPruneResult>;
  tryAcquireLease?: (key: string, owner: string, ttlMs: number, nowMs: number) => Promise<boolean>;
  releaseLease?: (key: string, owner: string) => Promise<void>;
  markFamilySeen?: (familyHash: string, nowMs: number, windowMs: number) => Promise<boolean>;
  recordRollups?: (deltas: RollupDelta[]) => Promise<void>;
  queryRollups?: (metrics: string[], from: number, to: number) => Promise<RollupBucket[]>;

  constructor(options: TieredStorageOptions) {
    this.hot = options.hot;
    this.cold = options.cold;
    const hot = this.hot;
    const pruneScoped = hot.pruneScoped;
    if (pruneScoped) {
      this.pruneScoped = async (input) => {
        const deleted = await pruneScoped.call(hot, input);
        await this.maintainCold();
        return deleted;
      };
    }
    const pruneScopedBatch = hot.pruneScopedBatch;
    if (pruneScopedBatch) {
      this.pruneScopedBatch = async (input) => {
        const result = await pruneScopedBatch.call(hot, input);
        await this.maintainCold();
        return result;
      };
    }
    const { tryAcquireLease, releaseLease, markFamilySeen } = hot;
    if (tryAcquireLease && releaseLease) {
      this.tryAcquireLease = (...args) => tryAcquireLease.apply(hot, args);
      this.releaseLease = (...args) => releaseLease.apply(hot, args);
    }
    if (markFamilySeen) this.markFamilySeen = (...args) => markFamilySeen.apply(hot, args);
    if (isRollupStore(hot)) {
      this.recordRollups = (deltas) => hot.recordRollups(deltas);
      this.queryRollups = (metrics, from, to) => hot.queryRollups(metrics, from, to);
    }
  }

  async init(): Promise<void> {
    await this.hot.init?.();
    await this.cold.init();
  }

  async close(): Promise<void> {
    await this.hot.close?.();
    await this.cold.close();
  }

  store(entries: Entry[]): Promise<void> {
    return this.hot.store(entries);
  }

  /** Hot only: an update completes a request seconds after it is stored, long before archiving. */
  update(id: string, patch: Partial<Entry>): Promise<void> {
    return this.hot.update(id, patch);
  }

  async find(id: string): Promise<EntryWithBatch | null> {
    const hot = await this.hot.find(id);
    if (hot !== null) {
      const { batch, ...entry } = hot;
      return { ...entry, batch: await this.mergeBatch(entry.batchId, batch) };
    }
    const cold = await this.coldOr(() => this.cold.find(id), null);
    if (cold === null) return null;
    return { ...cold, batch: await this.batch(cold.batchId) };
  }

  async batch(batchId: string): Promise<Entry[]> {
    return this.mergeBatch(batchId, await this.hot.batch(batchId));
  }

  async get(query: EntryQuery): Promise<Page<Entry>> {
    const limit =
      query.limit !== undefined && Number.isInteger(query.limit) && query.limit > 0
        ? query.limit
        : DEFAULT_LIMIT;
    if (query.ids !== undefined && query.ids.length === 0) return { data: [], nextCursor: null };

    const hot = await this.hotPage(query, limit + 1);
    let coldQuery: EntryQuery = { ...query };
    if (query.ids !== undefined) {
      const found = new Set(hot.map((entry) => entry.id));
      const missing = query.ids.filter((id) => !found.has(id));
      if (missing.length === 0) return this.page(hot, [], limit, false);
      coldQuery = { ...coldQuery, ids: missing };
    }
    // A full hot page bounds what the cold tier can still contribute: only entries at or after
    // the last hot one can make it into this page.
    const lastHot = hot.length > limit ? hot[limit] : undefined;
    if (lastHot !== undefined) {
      const floor = new Date(lastHot.createdAt.getTime() - 1);
      if (query.after === undefined || query.after < floor)
        coldQuery = { ...coldQuery, after: floor };
    }
    let partial = false;
    const cold = await this.coldOr(
      () => this.cold.query(coldQuery, limit + 1),
      [] as Entry[],
      () => {
        partial = true;
      },
    );
    return this.page(hot, cold, limit, partial);
  }

  async tags(prefix?: string, query?: TagQuery): Promise<TagCount[]> {
    const search = query?.search?.trim();
    const [hot, cold] = await Promise.all([
      this.hot.tags(prefix, search ? { search } : undefined),
      this.coldOr(() => this.cold.tags(prefix, search), [] as TagCount[]),
    ]);
    const counts = new Map<string, number>();
    for (const { tag, count } of [...hot, ...cold]) {
      if (prefix !== undefined && !tag.startsWith(prefix)) continue;
      if (search && !tag.toLowerCase().includes(search.toLowerCase())) continue;
      counts.set(tag, (counts.get(tag) ?? 0) + count);
    }
    const ordered = [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
    if (query?.limit === undefined) return ordered;
    const offset = query.offset ?? 0;
    return ordered.slice(offset, offset + query.limit);
  }

  /** Hot only: the cold tier's retention is its own (lifecycle rules or `retention`). */
  async prune(olderThan: Date, keepLast?: number): Promise<number> {
    const deleted = await this.hot.prune(olderThan, keepLast);
    await this.maintainCold();
    return deleted;
  }

  async clear(): Promise<void> {
    await this.hot.clear();
    await this.cold.clear();
  }

  /**
   * Up to `count` hot entries strictly behind the query's cursor. The cursor is this provider's
   * own `(createdAt, id)` position, so it is turned into a `before` bound plus a skip of the
   * same-millisecond ids already returned — which works whatever cursor format the hot store
   * uses internally.
   */
  private async hotPage(query: EntryQuery, count: number): Promise<Entry[]> {
    const position = query.cursor ? decodeCursor(query.cursor) : null;
    const { cursor: _ignored, ...rest } = query;
    let before = query.before;
    if (position !== null) {
      const atCursor = new Date(position.createdAt + 1);
      if (before === undefined || atCursor < before) before = atCursor;
    }
    const out: Entry[] = [];
    let hotCursor: string | undefined;
    for (let page = 0; page < MAX_HOT_PAGES; page += 1) {
      const result = await this.hot.get({
        ...rest,
        ...(before !== undefined ? { before } : {}),
        limit: count,
        ...(hotCursor !== undefined ? { cursor: hotCursor } : {}),
      });
      for (const entry of result.data) {
        if (
          position !== null &&
          entry.createdAt.getTime() === position.createdAt &&
          entry.id >= position.id
        ) {
          continue;
        }
        out.push(entry);
      }
      if (out.length >= count || result.nextCursor === null) break;
      hotCursor = result.nextCursor;
    }
    return out.sort(newestFirst).slice(0, count);
  }

  private page(hot: Entry[], cold: Entry[], limit: number, partial: boolean): Page<Entry> {
    const merged = dedupe([...hot, ...cold]).sort(newestFirst);
    const data = merged.slice(0, limit);
    const last = data.at(-1);
    return {
      data,
      nextCursor:
        merged.length > limit && last ? encodeCursor(last.createdAt.getTime(), last.id) : null,
      ...(partial ? { partial: true } : {}),
    };
  }

  private async mergeBatch(batchId: string, hot: Entry[]): Promise<Entry[]> {
    const cold = await this.coldOr(
      () => this.cold.batch(batchId, { wholeTierOnMiss: hot.length === 0 }),
      [] as Entry[],
    );
    return dedupe([...hot, ...cold]).sort((a, b) => a.sequence - b.sequence);
  }

  /** Runs a cold read, degrading to `fallback` (and warning once per outage) when it fails. */
  private async coldOr<T>(read: () => Promise<T>, fallback: T, onFailure?: () => void): Promise<T> {
    try {
      const value = await read();
      this.warnedColdFailure = false;
      return value;
    } catch (error) {
      onFailure?.();
      this.warnColdFailure(error);
      return fallback;
    }
  }

  private warnColdFailure(error: unknown): void {
    if (this.warnedColdFailure) return;
    this.warnedColdFailure = true;
    this.logger.warn(
      `Telescope cold tier (${this.cold.location.describedAs}) could not be read; serving hot entries only until it recovers: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  private async maintainCold(): Promise<void> {
    try {
      await this.cold.maintain();
    } catch (error) {
      this.logger.warn(
        `Telescope cold tier maintenance failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export function tieredStorage(options: TieredStorageOptions): TieredStorageProvider {
  return new TieredStorageProvider(options);
}
