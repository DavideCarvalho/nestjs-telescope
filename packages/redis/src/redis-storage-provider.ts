import {
  type Entry,
  type EntryQuery,
  type EntryWithBatch,
  HISTOGRAM_BUCKET_COUNT,
  type Page,
  type PruneScope,
  type RollupBucket,
  type RollupDelta,
  type RollupStore,
  type StorageProvider,
  type TagCount,
  emptyHistogram,
  isBatchOrigin,
  mergeHistograms,
  normalizeHistogram,
  safeJsonParse,
} from '@dudousxd/nestjs-telescope';
import type { Redis } from 'ioredis';
import { idFromMember, invBound, lexMember } from './lex-key.js';

export interface RedisStorageOptions {
  /** Namespace for every Telescope key. Defaults to `'telescope:'`. */
  keyPrefix?: string;
}

const DEFAULT_PREFIX = 'telescope:';
const SCAN_COUNT = 200;
const DEFAULT_LIMIT = 50;

/**
 * Atomically merge one rollup delta into its `(metric, bucket)` hash, server-side.
 * count/sum and each histogram cell accumulate via HINCRBY; `max` is a
 * compare-and-set (HINCRBY can't do max); the bucket registers in its per-metric
 * index. Doing it in one script removes the read-then-set race the old
 * client-side HGET→merge→HSET had — concurrent writers to the same bucket no
 * longer lose each other's histogram increments or clobber a higher `max`.
 *
 * KEYS: [rollupKey, rollupIndexKey]
 * ARGV: [bucketStart, count, sum, max, ...histogramCells]
 *
 * The histogram is stored as one field per cell (`h0`..`h{N-1}`) rather than a
 * JSON blob, so each cell is an atomic counter. Reads merge these with any
 * legacy JSON `histogram` field still present on pre-migration buckets. Uses
 * only numeric commands (no cjson) so it runs identically on ioredis-mock.
 */
const RECORD_ROLLUP_LUA = `
local key = KEYS[1]
redis.call('HINCRBY', key, 'count', ARGV[2])
redis.call('HINCRBY', key, 'sum', ARGV[3])
local cur = redis.call('HGET', key, 'max')
if (not cur) or (tonumber(ARGV[4]) > tonumber(cur)) then
  redis.call('HSET', key, 'max', ARGV[4])
end
local cells = #ARGV - 4
for i = 0, cells - 1 do
  local d = tonumber(ARGV[5 + i])
  if d ~= 0 then
    redis.call('HINCRBY', key, 'h' .. i, d)
  end
end
redis.call('ZADD', KEYS[2], ARGV[1], ARGV[1])
return 1
`;

/**
 * Redis-backed shared storage provider (ioredis). Suitable for multi-replica
 * deployments where every instance reads/writes the same store.
 *
 * Key scheme (all prefixed with `keyPrefix`):
 * - `e:<id>`               string  — JSON-serialized {@link Entry}
 * - `idx`                  ZSET    — score 0, member `lexMember(createdAt,id)` (newest-first)
 * - `idx:type:<type>`      ZSET    — same encoding, one per type
 * - `idx:tag:<tag>`        ZSET    — same encoding, one per tag
 * - `idx:family:<fh>`      ZSET    — same encoding, one per family hash
 * - `batch:<batchId>`      ZSET    — score = sequence, member = id
 * - `tags`                 HASH    — tag → count
 * - `r:<metric>:<bucket>`  HASH    — rollup fields `count`/`sum`/`max` + one
 *                                    atomic histogram cell per bucket (`h0`..`h13`);
 *                                    legacy rows may instead carry a JSON `histogram`
 * - `rz:<metric>`          ZSET    — score = bucketStart, member = bucketStart
 *
 * The host owns the injected ioredis connection; {@link close} is a no-op.
 */
export class RedisStorageProvider implements StorageProvider, RollupStore {
  private readonly redis: Redis;
  private readonly prefix: string;

  constructor(redis: Redis, options: RedisStorageOptions = {}) {
    this.redis = redis;
    this.prefix = options.keyPrefix ?? DEFAULT_PREFIX;
  }

  async store(entries: Entry[]): Promise<void> {
    if (entries.length === 0) return;

    const pipeline = this.redis.multi();
    for (const entry of entries) {
      const member = lexMember(entry.createdAt.getTime(), entry.id);
      pipeline.set(this.entryKey(entry.id), JSON.stringify(entry));
      pipeline.zadd(this.indexKey(), 0, member);
      pipeline.zadd(this.typeIndexKey(entry.type), 0, member);
      if (entry.familyHash !== null) {
        pipeline.zadd(this.familyIndexKey(entry.familyHash), 0, member);
      }
      pipeline.zadd(this.batchKey(entry.batchId), entry.sequence, entry.id);
      for (const tag of entry.tags) {
        pipeline.zadd(this.tagIndexKey(tag), 0, member);
        pipeline.hincrby(this.tagsKey(), tag, 1);
      }
    }
    await pipeline.exec();
  }

  async find(id: string): Promise<EntryWithBatch | null> {
    const raw = await this.redis.get(this.entryKey(id));
    if (raw === null) return null;
    const entry = this.parseEntry(raw);
    if (entry === null) return null;
    return { ...entry, batch: await this.batch(entry.batchId) };
  }

  async batch(batchId: string): Promise<Entry[]> {
    const ids = await this.redis.zrange(this.batchKey(batchId), 0, -1);
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(...ids.map((id) => this.entryKey(id)));
    const entries: Entry[] = [];
    for (const raw of raws) {
      if (raw === null) continue;
      const entry = this.parseEntry(raw);
      if (entry !== null) entries.push(entry);
    }
    return entries;
  }

  async tags(prefix?: string): Promise<TagCount[]> {
    const hash = await this.redis.hgetall(this.tagsKey());
    const result: TagCount[] = [];
    for (const [tag, rawCount] of Object.entries(hash)) {
      const count = Number(rawCount);
      if (count <= 0) continue;
      if (prefix !== undefined && !tag.startsWith(prefix)) continue;
      result.push({ tag, count });
    }
    return result;
  }

  async clear(): Promise<void> {
    const pattern = `${this.prefix}*`;
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT);
      cursor = next;
      if (keys.length > 0) await this.redis.del(...keys);
    } while (cursor !== '0');
  }

  /**
   * Newest-first keyset pagination via `ZRANGEBYLEX` over a single primary index.
   *
   * Members are `lexMember(createdAt, id)` = `<inv(createdAt)>:<id>` with newest
   * sorting lexicographically smallest, so an ascending lex range is newest-first.
   * The opaque cursor IS the last returned member string.
   *
   * NOTE: the dashboard issues single-filter queries (type OR tag OR family OR
   * batch). When MULTIPLE filters are set we page the primary index and AND the
   * remaining predicates in app code (best-effort), refetching pages until the
   * limit is filled or the index is exhausted.
   */
  async get(query: EntryQuery): Promise<Page<Entry>> {
    // Batched hydration fast path: when explicit ids are requested we fetch them
    // directly by key in ONE MGET rather than scanning an index. This is the big
    // win for pulse hydration — N per-id reads collapse into a single round-trip.
    if (query.ids !== undefined) {
      return this.getByIds(query);
    }

    const limit =
      query.limit !== undefined && Number.isInteger(query.limit) && query.limit > 0
        ? query.limit
        : DEFAULT_LIMIT;

    const indexKey = this.primaryIndexKey(query);
    const max = this.maxBound(query);
    const needsPostFilter = this.needsPostFilter(query, indexKey);

    // Cursor is the opaque member string; an empty/undecodable cursor starts at `-`.
    let min =
      typeof query.cursor === 'string' && query.cursor.length > 0
        ? `(${query.cursor}`
        : this.minBound(query);

    // We want `limit` matches plus one extra to know whether more remain. Each
    // kept match carries its member so the page's last member becomes the cursor.
    const kept: { entry: Entry; member: string }[] = [];

    while (kept.length <= limit) {
      const members = await this.redis.zrangebylex(indexKey, min, max, 'LIMIT', 0, limit + 1);
      if (members.length === 0) break;

      const ids = members.map(idFromMember);
      const raws = await this.redis.mget(...ids.map((id) => this.entryKey(id)));

      for (let i = 0; i < members.length; i++) {
        const member = members[i];
        if (member === undefined) continue;
        // Advance the resume point past every member we examine.
        min = `(${member}`;
        const raw = raws[i];
        const entry = raw === null || raw === undefined ? null : this.parseEntry(raw);
        if (entry === null) continue;
        if (needsPostFilter && !this.matchesSecondary(entry, query, indexKey)) continue;
        kept.push({ entry, member });
        if (kept.length > limit) break;
      }

      // Without post-filtering, a short page means the index is exhausted.
      if (!needsPostFilter && members.length <= limit) break;
      if (kept.length > limit) break;
    }

    const hasMore = kept.length > limit;
    const page = kept.slice(0, limit);
    const last = page.at(-1);
    // omitContent: Redis stores the whole entry as one JSON blob, so there is no
    // projection benefit here — the entry must be read and parsed anyway. We
    // still null `content` afterwards so callers can never depend on it during a
    // content-less scan, keeping behavior identical to the projecting providers.
    const data = query.omitContent
      ? page.map((item) => ({ ...item.entry, content: null }))
      : page.map((item) => item.entry);
    return {
      data,
      nextCursor: hasMore && last ? last.member : null,
    };
  }

  /**
   * Fetch a specific set of ids by key in ONE `MGET`, then AND any remaining
   * filters in app code. Missing ids (and unparseable blobs) are simply absent.
   * Empty ids ⇒ no rows. Results are sorted newest-first and capped at `limit`,
   * mirroring the index-scan path's ordering and projection (omitContent).
   */
  private async getByIds(query: EntryQuery): Promise<Page<Entry>> {
    const ids = query.ids ?? [];
    if (ids.length === 0) {
      return { data: [], nextCursor: null };
    }

    const raws = await this.redis.mget(...ids.map((id) => this.entryKey(id)));
    const entries: Entry[] = [];
    for (const raw of raws) {
      if (raw === null) continue;
      const entry = this.parseEntry(raw);
      if (entry !== null && this.matchesIdPathFilters(entry, query)) {
        entries.push(entry);
      }
    }

    entries.sort((a, b) => {
      const delta = b.createdAt.getTime() - a.createdAt.getTime();
      return delta !== 0 ? delta : b.id.localeCompare(a.id);
    });

    const limit =
      query.limit !== undefined && Number.isInteger(query.limit) && query.limit > 0
        ? query.limit
        : DEFAULT_LIMIT;
    const page = entries.slice(0, limit);
    const data = query.omitContent ? page.map((entry) => ({ ...entry, content: null })) : page;
    return { data, nextCursor: null };
  }

  /** AND the non-id predicates for the ids fast path (no index to lean on here). */
  private matchesIdPathFilters(entry: Entry, query: EntryQuery): boolean {
    if (query.type !== undefined && entry.type !== query.type) return false;
    if (query.tag !== undefined && !entry.tags.includes(query.tag)) return false;
    if (query.familyHash !== undefined && entry.familyHash !== query.familyHash) return false;
    if (query.batchId !== undefined && entry.batchId !== query.batchId) return false;
    if (query.traceId !== undefined && entry.traceId !== query.traceId) return false;
    if (query.before !== undefined && entry.createdAt.getTime() >= query.before.getTime()) {
      return false;
    }
    if (query.after !== undefined && entry.createdAt.getTime() <= query.after.getTime()) {
      return false;
    }
    if (
      query.search !== undefined &&
      !JSON.stringify(entry.content).toLowerCase().includes(query.search.toLowerCase())
    ) {
      return false;
    }
    return true;
  }

  /** Mirror in-memory `update`: merge patch, keep `id` immutable; missing → no-op.
   *  Patches never touch createdAt/id in practice, so the indexes never drift. */
  async update(id: string, patch: Partial<Entry>): Promise<void> {
    const raw = await this.redis.get(this.entryKey(id));
    if (raw === null) return;
    const existing = this.parseEntry(raw);
    if (existing === null) return;
    const merged: Entry = { ...existing, ...patch, id: existing.id };
    await this.redis.set(this.entryKey(id), JSON.stringify(merged));
  }

  /**
   * Remove entries with `createdAt < olderThan`. Older = larger inv = lexically
   * greater, so the prune candidates are `ZRANGEBYLEX idx (<invBound(olderThan)> +`.
   *
   * Mirrors in-memory `prune`: when `keepLast` is set, the newest `keepLast` of
   * the to-be-pruned entries survive; the rest (and their index/tag bookkeeping)
   * are removed. Returns the number actually removed.
   */
  async prune(olderThan: Date, keepLast?: number): Promise<number> {
    return this.pruneWith(this.indexKey(), olderThan, keepLast, null);
  }

  async pruneScoped(input: PruneScope): Promise<number> {
    // Scope by SOURCE INDEX where possible: a single `type` scans that type's
    // own inv-ordered index (no false candidates, no per-entry type re-check).
    // `excludeTypes` has no precomputed index, so scan the primary index and
    // skip excluded types after loading each entry (we load it anyway to clean
    // up its secondary indexes). `keepLast` semantics match prune().
    if (input.type !== undefined) {
      return this.pruneWith(this.typeIndexKey(input.type), input.before, input.keepLast, null);
    }
    const excluded =
      input.excludeTypes !== undefined && input.excludeTypes.length > 0
        ? new Set(input.excludeTypes)
        : null;
    return this.pruneWith(this.indexKey(), input.before, input.keepLast, excluded);
  }

  /**
   * Shared prune core. Scans `sourceIndex` for members older than `olderThan`,
   * spares the newest `keepLast` of them, optionally drops members whose entry
   * `type` is in `excludeTypes`, and removes the survivors' rows plus every
   * secondary index reference in one pipeline. Returns the number removed.
   */
  private async pruneWith(
    sourceIndex: string,
    olderThan: Date,
    keepLast: number | undefined,
    excludeTypes: Set<string> | null,
  ): Promise<number> {
    const boundary = invBound(olderThan.getTime());
    // Candidates are returned oldest-first (largest member first is `+`, but
    // ZRANGEBYLEX is ascending, so smaller inv→ first; within this range the
    // smallest member is the newest of the OLD entries).
    const candidates = await this.redis.zrangebylex(sourceIndex, `(${boundary}`, '+');
    if (candidates.length === 0) return 0;

    // candidates ascending = newest-first among the old set. Keep the newest `keepLast`.
    const keep = keepLast !== undefined ? Math.max(0, keepLast) : 0;
    const toRemoveMembers = candidates.slice(keep);
    if (toRemoveMembers.length === 0) return 0;

    const ids = toRemoveMembers.map(idFromMember);
    const raws = await this.redis.mget(...ids.map((id) => this.entryKey(id)));

    const pipeline = this.redis.multi();
    let removed = 0;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const member = toRemoveMembers[i];
      if (id === undefined || member === undefined) continue;
      const raw = raws[i];
      const entry = raw === null || raw === undefined ? null : this.parseEntry(raw);
      // excludeTypes carve-out: spare any entry whose type is excluded. A row
      // with no readable entry can't be type-checked, so it is removed (it is
      // already orphaned/old and would otherwise leak its index members).
      if (excludeTypes !== null && entry !== null && excludeTypes.has(entry.type)) {
        continue;
      }
      removed++;
      pipeline.del(this.entryKey(id));
      pipeline.zrem(this.indexKey(), member);
      if (entry !== null) {
        pipeline.zrem(this.typeIndexKey(entry.type), member);
        if (entry.familyHash !== null) {
          pipeline.zrem(this.familyIndexKey(entry.familyHash), member);
        }
        pipeline.zrem(this.batchKey(entry.batchId), id);
        for (const tag of entry.tags) {
          pipeline.zrem(this.tagIndexKey(tag), member);
          pipeline.hincrby(this.tagsKey(), tag, -1);
        }
      }
    }
    await pipeline.exec();
    return removed;
  }

  /** The host owns the injected connection, so closing it is its responsibility. */
  close(): void {
    // no-op
  }

  // ── RollupStore SPI ────────────────────────────────────────────────────────

  /**
   * Additively merge deltas into their rollup hashes. Each delta is applied by a
   * single atomic Lua script ({@link RECORD_ROLLUP_LUA}): count/sum and every
   * histogram cell accumulate via HINCRBY, `max` is a compare-and-set, and the
   * bucket registers in its per-metric index — all server-side, so concurrent
   * writers to the same (metric, bucket) can't lose each other's increments.
   * Deltas target independent buckets, so they run concurrently.
   */
  async recordRollups(deltas: RollupDelta[]): Promise<void> {
    if (deltas.length === 0) return;
    await Promise.all(
      deltas.map((delta) => {
        const cells = normalizeHistogram(delta.histogram);
        return this.redis.eval(
          RECORD_ROLLUP_LUA,
          2,
          this.rollupKey(delta.metric, delta.bucketStart),
          this.rollupIndexKey(delta.metric),
          String(delta.bucketStart),
          String(delta.count),
          String(delta.sum),
          String(delta.max),
          ...cells.map((cell) => String(cell)),
        );
      }),
    );
  }

  /**
   * Buckets for the given metrics whose bucketStart is in [fromBucket, toBucket].
   * Per metric: ZRANGEBYSCORE the index for in-range bucketStarts, then HGETALL
   * each rollup hash. Empty metrics ⇒ [].
   */
  async queryRollups(
    metrics: string[],
    fromBucket: number,
    toBucket: number,
  ): Promise<RollupBucket[]> {
    if (metrics.length === 0) return [];

    const result: RollupBucket[] = [];
    for (const metric of metrics) {
      const buckets = await this.redis.zrangebyscore(
        this.rollupIndexKey(metric),
        fromBucket,
        toBucket,
      );
      for (const bucketStartRaw of buckets) {
        const bucketStart = Number(bucketStartRaw);
        const hash = await this.redis.hgetall(this.rollupKey(metric, bucketStart));
        if (Object.keys(hash).length === 0) continue;
        result.push({
          metric,
          bucketStart,
          count: Number(hash.count ?? 0),
          sum: Number(hash.sum ?? 0),
          max: Number(hash.max ?? 0),
          histogram: this.readHistogram(hash),
        });
      }
    }
    return result;
  }

  /**
   * Resiliently parse a stored entry: bad JSON yields null (dropped by callers),
   * and `createdAt` is revived from its ISO string back into a Date.
   */
  private parseEntry(raw: string): Entry | null {
    const parsed = safeJsonParse<Record<string, unknown> | null>(raw, null);
    if (parsed === null || typeof parsed !== 'object') return null;
    const candidate = parsed as Omit<Partial<Entry>, 'createdAt'> & { createdAt?: unknown };
    if (typeof candidate.id !== 'string' || typeof candidate.batchId !== 'string') {
      return null;
    }
    const createdAt =
      typeof candidate.createdAt === 'string' || typeof candidate.createdAt === 'number'
        ? new Date(candidate.createdAt)
        : new Date(Number.NaN);
    return {
      id: candidate.id,
      batchId: candidate.batchId,
      type: typeof candidate.type === 'string' ? candidate.type : '',
      familyHash: typeof candidate.familyHash === 'string' ? candidate.familyHash : null,
      content: candidate.content ?? {},
      tags: Array.isArray(candidate.tags) ? candidate.tags : [],
      sequence: typeof candidate.sequence === 'number' ? candidate.sequence : 0,
      durationMs: typeof candidate.durationMs === 'number' ? candidate.durationMs : null,
      origin: isBatchOrigin(candidate.origin) ? candidate.origin : 'manual',
      instanceId: typeof candidate.instanceId === 'string' ? candidate.instanceId : '',
      traceId: typeof candidate.traceId === 'string' ? candidate.traceId : null,
      spanId: typeof candidate.spanId === 'string' ? candidate.spanId : null,
      createdAt,
    };
  }

  /** Single primary index for a query: type, else tag, else family, else global. */
  private primaryIndexKey(query: EntryQuery): string {
    if (query.type !== undefined) return this.typeIndexKey(query.type);
    if (query.tag !== undefined) return this.tagIndexKey(query.tag);
    if (query.familyHash !== undefined) return this.familyIndexKey(query.familyHash);
    return this.indexKey();
  }

  /**
   * Lower lex bound for the range when there is no cursor. `before` (createdAt <
   * beforeMs → older → larger inv → larger member) raises the MIN. Since createdAt
   * is integer ms, `createdAt < beforeMs` ⟺ `createdAt <= beforeMs - 1`, whose
   * smallest qualifying inv is `invBound(beforeMs - 1)`, so `[invBound(beforeMs-1)`
   * is an inclusive lower bound.
   */
  private minBound(query: EntryQuery): string {
    if (query.before !== undefined) {
      return `[${invBound(query.before.getTime() - 1)}`;
    }
    return '-';
  }

  /**
   * Upper lex bound. `after` (createdAt > afterMs → newer → smaller inv → smaller
   * member) lowers the MAX. A member at exactly afterMs is `invBound(afterMs):id`
   * which is `> invBound(afterMs)`, so `(invBound(afterMs)` (exclusive) excludes
   * everything `>= invBound(afterMs)`, keeping only strictly-newer entries.
   */
  private maxBound(query: EntryQuery): string {
    if (query.after !== undefined) {
      return `(${invBound(query.after.getTime())}`;
    }
    return '+';
  }

  /** Whether predicates beyond the chosen primary index must be applied in app code. */
  private needsPostFilter(query: EntryQuery, indexKey: string): boolean {
    const primaryHandlesType =
      query.type !== undefined && indexKey === this.typeIndexKey(query.type);
    const primaryHandlesTag = query.tag !== undefined && indexKey === this.tagIndexKey(query.tag);
    const primaryHandlesFamily =
      query.familyHash !== undefined && indexKey === this.familyIndexKey(query.familyHash);

    if (query.type !== undefined && !primaryHandlesType) return true;
    if (query.tag !== undefined && !primaryHandlesTag) return true;
    if (query.familyHash !== undefined && !primaryHandlesFamily) return true;
    if (query.batchId !== undefined) return true;
    if (query.traceId !== undefined) return true;
    if (query.search !== undefined) return true;
    return false;
  }

  /** Apply the secondary AND predicates not covered by the primary index. */
  private matchesSecondary(entry: Entry, query: EntryQuery, indexKey: string): boolean {
    if (
      query.type !== undefined &&
      indexKey !== this.typeIndexKey(query.type) &&
      entry.type !== query.type
    ) {
      return false;
    }
    if (
      query.tag !== undefined &&
      indexKey !== this.tagIndexKey(query.tag) &&
      !entry.tags.includes(query.tag)
    ) {
      return false;
    }
    if (
      query.familyHash !== undefined &&
      indexKey !== this.familyIndexKey(query.familyHash) &&
      entry.familyHash !== query.familyHash
    ) {
      return false;
    }
    if (query.batchId !== undefined && entry.batchId !== query.batchId) return false;
    if (query.traceId !== undefined && entry.traceId !== query.traceId) return false;
    if (
      query.search !== undefined &&
      !JSON.stringify(entry.content).toLowerCase().includes(query.search.toLowerCase())
    ) {
      return false;
    }
    return true;
  }

  private entryKey(id: string): string {
    return `${this.prefix}e:${id}`;
  }

  private indexKey(): string {
    return `${this.prefix}idx`;
  }

  private typeIndexKey(type: string): string {
    return `${this.prefix}idx:type:${type}`;
  }

  private tagIndexKey(tag: string): string {
    return `${this.prefix}idx:tag:${tag}`;
  }

  private familyIndexKey(familyHash: string): string {
    return `${this.prefix}idx:family:${familyHash}`;
  }

  private batchKey(batchId: string): string {
    return `${this.prefix}batch:${batchId}`;
  }

  private tagsKey(): string {
    return `${this.prefix}tags`;
  }

  private rollupKey(metric: string, bucketStart: number): string {
    return `${this.prefix}r:${metric}:${bucketStart}`;
  }

  private rollupIndexKey(metric: string): string {
    return `${this.prefix}rz:${metric}`;
  }

  /**
   * Reconstruct a bucket's latency histogram from a rollup hash. Current writes
   * store one atomic counter per cell (`h0`..`h{N-1}`); pre-migration buckets
   * stored a single JSON `histogram` blob. Merge both so a bucket that straddles
   * the format change (legacy events in the blob, newer events in the cells)
   * reports the correct total. A given event is only ever recorded in one of the
   * two, so the merge never double-counts.
   */
  private readHistogram(hash: Record<string, string>): number[] {
    const cells = emptyHistogram();
    for (let i = 0; i < HISTOGRAM_BUCKET_COUNT; i += 1) {
      const raw = hash[`h${i}`];
      if (raw !== undefined) cells[i] = Number(raw);
    }
    return mergeHistograms(cells, this.parseHistogram(hash.histogram ?? null));
  }

  /**
   * Parses a stored histogram JSON field back into a number[]. Missing field
   * (legacy hash) and any malformed JSON yield null, which the caller normalizes
   * into an all-zeros array of the canonical length.
   */
  private parseHistogram(raw: string | null): number[] | null {
    if (raw === null) return null;
    const parsed = safeJsonParse<number[] | null>(raw, null);
    if (!Array.isArray(parsed)) return null;
    return parsed.map((value) => (typeof value === 'number' ? value : 0));
  }
}
