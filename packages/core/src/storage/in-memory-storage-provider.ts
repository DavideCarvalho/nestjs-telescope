// packages/core/src/storage/in-memory-storage-provider.ts
import type { Entry } from '../entry/entry.js';
import type { RollupBucket, RollupDelta, RollupStore } from '../rollup/rollup-store.js';
import { mergeHistograms, normalizeHistogram } from '../rollup/rollup-store.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import type {
  BoundedPruneCapable,
  BoundedPruneResult,
  BoundedPruneScope,
  EntryQuery,
  EntryWithBatch,
  LeaseCapableStorage,
  Page,
  PruneScope,
  TagCount,
} from './storage-provider.js';

const DEFAULT_LIMIT = 50;

/** One held lease in the process-local lease table. */
interface HeldLease {
  owner: string;
  expiresAtMs: number;
}

/**
 * Process-local store. Used as a test double and as a zero-dependency option
 * for single-instance/serverless setups. Newest-first ordering by createdAt
 * then id; cursor is an opaque keyset (createdAt-ms, id) position.
 *
 * Declared against {@link BoundedPruneCapable} and {@link LeaseCapableStorage}
 * (both of which extend `StorageProvider`) so dropping either capability from
 * this class is a compile error rather than a silent fall back to unbounded,
 * unlocked pruning.
 */
export class InMemoryStorageProvider
  implements BoundedPruneCapable, LeaseCapableStorage, RollupStore
{
  private entries: Entry[] = [];
  /** Materialized rollups keyed `${metric}|${bucketStart}`. */
  private rollups = new Map<string, RollupBucket>();
  /**
   * Process-local lease table. Only ever exclusive WITHIN this process, which is
   * exactly right: an in-memory store is not shared between replicas, so there is
   * no fleet to coordinate — this exists so the lock path behaves identically on
   * every provider rather than being a special case.
   */
  private readonly leases = new Map<string, HeldLease>();

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

  async pruneScoped(input: PruneScope): Promise<number> {
    const { before, type, excludeTypes, keepLast } = input;
    const excluded = excludeTypes !== undefined ? new Set(excludeTypes) : null;
    // A row is in scope when it is older than the cutoff AND matches the type
    // selector: a single `type`, OR (for the global bulk) any type NOT excluded.
    const inScope = (entry: Entry): boolean => {
      if (entry.createdAt >= before) return false;
      if (type !== undefined) return entry.type === type;
      if (excluded !== null) return !excluded.has(entry.type);
      return true;
    };
    const before_ = this.entries.length;
    const survivors = this.entries.filter((entry) => !inScope(entry));
    if (keepLast !== undefined && survivors.length < this.entries.length) {
      // Resurrect the newest `keepLast` of the doomed rows, mirroring prune().
      const reprieved = this.entries.filter(inScope).sort(this.newestFirst).slice(0, keepLast);
      this.entries = [...survivors, ...reprieved];
    } else {
      this.entries = survivors;
    }
    return before_ - this.entries.length;
  }

  async pruneScopedBatch(input: BoundedPruneScope): Promise<BoundedPruneResult> {
    const doomed = this.entries.filter((entry) => inBoundedScope(entry, input));
    if (doomed.length === 0) return { deleted: 0, hasMore: false };
    // Oldest first, matching the SPI: a partial cycle must reduce the age of the
    // oldest surviving entry, which is the number retention is judged on.
    doomed.sort(this.oldestFirst);
    const batch = new Set(doomed.slice(0, input.limit).map((entry) => entry.id));
    this.entries = this.entries.filter((entry) => !batch.has(entry.id));
    return { deleted: batch.size, hasMore: doomed.length > input.limit };
  }

  async tryAcquireLease(
    key: string,
    owner: string,
    ttlMs: number,
    nowMs: number,
  ): Promise<boolean> {
    const held = this.leases.get(key);
    // Grant when free, expired (the crashed-holder case), or already ours.
    if (held !== undefined && held.expiresAtMs > nowMs && held.owner !== owner) return false;
    this.leases.set(key, { owner, expiresAtMs: nowMs + ttlMs });
    return true;
  }

  async releaseLease(key: string, owner: string): Promise<void> {
    // Owner-checked: a holder whose lease already expired and was re-granted
    // must not release the new holder's lease.
    if (this.leases.get(key)?.owner === owner) this.leases.delete(key);
  }

  async clear(): Promise<void> {
    this.entries = [];
    this.rollups.clear();
    this.seenFamilies.clear();
    this.leases.clear();
  }

  /** Last-seen wall time (ms) per error family, backing the shared new-exception
   *  dedup. In a single process this is exactly the per-replica behaviour; the
   *  real cross-pod win comes from the SQLite/Redis providers that share a store. */
  private readonly seenFamilies = new Map<string, number>();

  async markFamilySeen(familyHash: string, nowMs: number, windowMs: number): Promise<boolean> {
    const last = this.seenFamilies.get(familyHash);
    const isNew = last === undefined || nowMs - last >= windowMs;
    this.seenFamilies.set(familyHash, nowMs);
    return isNew;
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
          histogram: normalizeHistogram(delta.histogram),
        });
      } else {
        existing.count += delta.count;
        existing.sum += delta.sum;
        existing.max = Math.max(existing.max, delta.max);
        existing.histogram = mergeHistograms(existing.histogram, delta.histogram);
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
        result.push({ ...bucket, histogram: normalizeHistogram(bucket.histogram) });
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

  private oldestFirst = (a: Entry, b: Entry): number => -this.newestFirst(a, b);
}

/** Same selection as `pruneScoped`, minus `keepLast` (not part of a bounded scope). */
function inBoundedScope(entry: Entry, scope: BoundedPruneScope): boolean {
  if (entry.createdAt >= scope.before) return false;
  if (scope.type !== undefined) return entry.type === scope.type;
  if (scope.excludeTypes !== undefined && scope.excludeTypes.length > 0) {
    return !scope.excludeTypes.includes(entry.type);
  }
  return true;
}
