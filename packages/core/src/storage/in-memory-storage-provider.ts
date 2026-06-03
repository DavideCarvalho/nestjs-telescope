// packages/core/src/storage/in-memory-storage-provider.ts
import type { Entry } from '../entry/entry.js';
import type { RollupBucket, RollupDelta, RollupStore } from '../rollup/rollup-store.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import type {
  EntryQuery,
  EntryWithBatch,
  Page,
  StorageProvider,
  TagCount,
} from './storage-provider.js';

const DEFAULT_LIMIT = 50;

/**
 * Process-local store. Used as a test double and as a zero-dependency option
 * for single-instance/serverless setups. Newest-first ordering by createdAt
 * then id; cursor is an opaque keyset (createdAt-ms, id) position.
 */
export class InMemoryStorageProvider implements StorageProvider, RollupStore {
  private entries: Entry[] = [];
  /** Materialized rollups keyed `${metric}|${bucketStart}`. */
  private rollups = new Map<string, RollupBucket>();

  async store(entries: Entry[]): Promise<void> {
    this.entries.push(...entries);
  }

  async update(id: string, patch: Partial<Entry>): Promise<void> {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index === -1) return;
    const existing = this.entries[index];
    if (existing === undefined) return;
    this.entries[index] = { ...existing, ...patch, id: existing.id };
  }

  async find(id: string): Promise<EntryWithBatch | null> {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) {
      return null;
    }
    return { ...entry, batch: await this.batch(entry.batchId) };
  }

  async get(query: EntryQuery): Promise<Page<Entry>> {
    // Build the ids membership set once (not per entry) when an ids filter is set.
    const idSet = query.ids !== undefined ? new Set(query.ids) : null;
    const filtered = [...this.entries]
      .filter((entry) => this.matches(entry, query, idSet))
      .sort(this.newestFirst);

    const cursor = query.cursor ? decodeCursor(query.cursor) : null;

    const afterCursor = cursor
      ? filtered.filter(
          (e) =>
            e.createdAt.getTime() < cursor.createdAt ||
            (e.createdAt.getTime() === cursor.createdAt && e.id < cursor.id),
        )
      : filtered;

    const limit =
      query.limit !== undefined && Number.isInteger(query.limit) && query.limit > 0
        ? query.limit
        : DEFAULT_LIMIT;
    const slice = afterCursor.slice(0, limit);
    const hasMore = afterCursor.length > limit;
    const last = slice.at(-1);
    // omitContent: hand back shallow copies with content nulled so callers can
    // never accidentally depend on content during a content-less aggregate scan.
    const data = query.omitContent ? slice.map((entry) => ({ ...entry, content: null })) : slice;
    return {
      data,
      nextCursor: hasMore && last ? encodeCursor(last.createdAt.getTime(), last.id) : null,
    };
  }

  async batch(batchId: string): Promise<Entry[]> {
    return this.entries
      .filter((entry) => entry.batchId === batchId)
      .sort((a, b) => a.sequence - b.sequence);
  }

  async tags(prefix?: string): Promise<TagCount[]> {
    const counts = new Map<string, number>();
    for (const entry of this.entries) {
      for (const tag of entry.tags) {
        if (!prefix || tag.startsWith(prefix)) {
          counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
      }
    }
    return [...counts.entries()].map(([tag, count]) => ({ tag, count }));
  }

  async prune(olderThan: Date, keepLast?: number): Promise<number> {
    const before = this.entries.length;
    let survivors = this.entries.filter((entry) => entry.createdAt >= olderThan);
    if (keepLast !== undefined && survivors.length < this.entries.length) {
      const pruned = [...this.entries]
        .filter((entry) => entry.createdAt < olderThan)
        .sort(this.newestFirst)
        .slice(0, keepLast);
      survivors = [...survivors, ...pruned];
    }
    this.entries = survivors;
    return before - this.entries.length;
  }

  async clear(): Promise<void> {
    this.entries = [];
    this.rollups.clear();
  }

  // ── RollupStore SPI ────────────────────────────────────────────────────────

  async recordRollups(deltas: RollupDelta[]): Promise<void> {
    for (const delta of deltas) {
      const key = `${delta.metric}|${delta.bucketStart}`;
      const existing = this.rollups.get(key);
      if (existing === undefined) {
        this.rollups.set(key, {
          metric: delta.metric,
          bucketStart: delta.bucketStart,
          count: delta.count,
          sum: delta.sum,
          max: delta.max,
        });
      } else {
        existing.count += delta.count;
        existing.sum += delta.sum;
        existing.max = Math.max(existing.max, delta.max);
      }
    }
  }

  async queryRollups(
    metrics: string[],
    fromBucket: number,
    toBucket: number,
  ): Promise<RollupBucket[]> {
    const wanted = new Set(metrics);
    const result: RollupBucket[] = [];
    for (const bucket of this.rollups.values()) {
      if (
        wanted.has(bucket.metric) &&
        bucket.bucketStart >= fromBucket &&
        bucket.bucketStart <= toBucket
      ) {
        result.push({ ...bucket });
      }
    }
    return result;
  }

  private matches(entry: Entry, query: EntryQuery, idSet: Set<string> | null): boolean {
    if (idSet !== null && !idSet.has(entry.id)) return false;
    if (query.type !== undefined && entry.type !== query.type) return false;
    if (query.tag !== undefined && !entry.tags.includes(query.tag)) return false;
    if (query.familyHash !== undefined && entry.familyHash !== query.familyHash) return false;
    if (query.batchId !== undefined && entry.batchId !== query.batchId) return false;
    if (query.traceId !== undefined && entry.traceId !== query.traceId) return false;
    if (
      query.search !== undefined &&
      !JSON.stringify(entry.content).toLowerCase().includes(query.search.toLowerCase())
    ) {
      return false;
    }
    if (query.before !== undefined && entry.createdAt >= query.before) return false;
    if (query.after !== undefined && entry.createdAt <= query.after) return false;
    return true;
  }

  private newestFirst = (a: Entry, b: Entry): number => {
    const delta = b.createdAt.getTime() - a.createdAt.getTime();
    return delta !== 0 ? delta : b.id.localeCompare(a.id);
  };
}
