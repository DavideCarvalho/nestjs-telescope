// packages/core/src/metrics/stats.service.ts
import { Inject, Injectable, Optional } from '@nestjs/common';
import { type Entry, EntryType } from '../entry/entry.js';
import { TELESCOPE_STORAGE } from '../nest/telescope.options.js';
import { estimatePercentileFromHistogram } from '../rollup/estimate-percentile.js';
import {
  type RollupStore,
  emptyHistogram,
  floorToBucket,
  isRollupStore,
  mergeHistograms,
} from '../rollup/rollup-store.js';
import type { EntryQuery, StorageProvider } from '../storage/storage-provider.js';
import { collectEntriesInWindow } from './collect-window.js';
import { type LatencyPercentilesOverride, type StatsResult, summarizeStats } from './stats.js';

const DEFAULT_BUCKETS = 60;
const MAX_BUCKETS = 500;
const DEFAULT_SLOW_MS = 100;
/** Ids per batched hydration read. */
const HYDRATE_CHUNK = 500;
const STATUS_TAG_PREFIX = 'status:';

export interface StatsQuery {
  /** Required — stats are computed per entry type. */
  type: string;
  windowMs: number;
  buckets?: number;
}

export interface StatsServiceOptions {
  pageSize?: number;
  scanCap?: number;
  /** Threshold (ms) at/above which an entry counts as slow. Default 100. */
  slowMs?: number;
  defaultBuckets?: number;
}

/** Computes per-type analytics (latency percentiles, family/cache/status
 *  breakdowns, throughput) by aggregating stored entries over a window.
 *  Reads the store on demand and delegates the maths to {@link summarizeStats}. */
@Injectable()
export class StatsService {
  private readonly pageSize: number | undefined;
  private readonly scanCap: number | undefined;
  private readonly slowMs: number;
  private readonly defaultBuckets: number;

  constructor(
    @Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider,
    @Optional() options?: StatsServiceOptions,
  ) {
    this.pageSize = options?.pageSize;
    this.scanCap = options?.scanCap;
    this.slowMs = options?.slowMs ?? DEFAULT_SLOW_MS;
    this.defaultBuckets = options?.defaultBuckets ?? DEFAULT_BUCKETS;
  }

  async getStats(query: StatsQuery): Promise<StatsResult> {
    if (!Number.isFinite(query.windowMs) || query.windowMs <= 0) {
      throw new RangeError(`windowMs must be a positive, finite number (got ${query.windowMs}).`);
    }
    const buckets = Math.min(
      MAX_BUCKETS,
      Math.max(1, Math.floor(query.buckets ?? this.defaultBuckets)),
    );
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - query.windowMs);

    // Cache stats read hit/miss from every entry's content, so only that type
    // scans with content. Every other type scans content-less columns and
    // hydrates just the content summarizeStats reads (see hydrateForStats).
    const scansContent = query.type === EntryType.Cache;
    const baseQuery: Omit<EntryQuery, 'cursor' | 'limit'> = {
      after: windowStart,
      type: query.type,
      ...(scansContent ? {} : { omitContent: true }),
    };
    const scan = await collectEntriesInWindow(this.storage, baseQuery, {
      ...(this.pageSize !== undefined ? { pageSize: this.pageSize } : {}),
      ...(this.scanCap !== undefined ? { scanCap: this.scanCap } : {}),
    });
    const { truncated } = scan;
    const entries = scansContent
      ? scan.entries
      : await this.hydrateForStats(query.type, scan.entries);

    // Fast path for the latency percentiles ONLY: when the store supports
    // rollups, estimate p50/p95/p99 from the pre-aggregated latency histogram
    // (O(buckets)) instead of sorting every raw durationMs (O(rows)). Everything
    // else summarizeStats does — count/max/slow, family/cache/status/exception
    // breakdowns, throughput — still derives from the raw scan. When the store
    // is NOT a RollupStore, the override is omitted and percentiles fall back to
    // the raw-scan computation unchanged.
    const latencyPercentiles = isRollupStore(this.storage)
      ? await this.estimatePercentiles(this.storage, query.type, windowStart, windowEnd)
      : undefined;

    return summarizeStats({
      entries,
      type: query.type,
      windowStart,
      windowEnd,
      windowMs: query.windowMs,
      buckets,
      slowMs: this.slowMs,
      truncated,
      ...(latencyPercentiles !== undefined ? { latencyPercentiles } : {}),
    });
  }

  /**
   * Gives content-less scan rows the content {@link summarizeStats} reads, and
   * nothing more:
   *  - query: the SQL of the first row of each family (the family label);
   *  - exception: the first row of each family, shared with the rest of that
   *    family (only the first row's class/message is kept), plus every row
   *    without a family hash (its key is derived from content);
   *  - request: `{ statusCode }` from the row's single `status:<code>` tag,
   *    which the built-in status tagger derives from that same content; rows
   *    without exactly one such tag are hydrated.
   * Other types' stats read no content.
   */
  private async hydrateForStats(type: string, entries: Entry[]): Promise<Entry[]> {
    if (type === EntryType.Request) return this.hydrateRequests(entries);
    if (type !== EntryType.Query && type !== EntryType.Exception) return entries;

    const firstOfFamily = new Map<string, Entry>();
    const unkeyed: string[] = [];
    for (const entry of entries) {
      if (entry.familyHash === null) {
        if (type === EntryType.Exception) unkeyed.push(entry.id);
      } else if (!firstOfFamily.has(entry.familyHash)) {
        firstOfFamily.set(entry.familyHash, entry);
      }
    }
    const representatives = [...firstOfFamily.values()].map((entry) => entry.id);
    const contentById = await this.contentFor([...representatives, ...unkeyed]);

    if (type === EntryType.Query) {
      return entries.map((entry) =>
        contentById.has(entry.id) ? { ...entry, content: contentById.get(entry.id) } : entry,
      );
    }

    // A family whose first row has no object content falls back to per-row
    // content, so the next row of that family can supply class/message.
    const familyContent = new Map<string, unknown>();
    const perRowFamilies = new Set<string>();
    for (const [familyHash, first] of firstOfFamily) {
      const content = contentById.get(first.id);
      if (typeof content === 'object' && content !== null) {
        familyContent.set(familyHash, content);
      } else {
        perRowFamilies.add(familyHash);
      }
    }
    if (perRowFamilies.size > 0) {
      const extra = await this.contentFor(
        entries
          .filter((entry) => entry.familyHash !== null && perRowFamilies.has(entry.familyHash))
          .map((entry) => entry.id),
      );
      for (const [id, content] of extra) contentById.set(id, content);
    }
    return entries.map((entry) => {
      const content =
        entry.familyHash !== null && familyContent.has(entry.familyHash)
          ? familyContent.get(entry.familyHash)
          : contentById.get(entry.id);
      return { ...entry, content: content ?? null };
    });
  }

  private async hydrateRequests(entries: Entry[]): Promise<Entry[]> {
    const missing: string[] = [];
    const fromTags = new Map<string, number>();
    for (const entry of entries) {
      const statusCode = statusFromTags(entry.tags);
      if (statusCode === null) missing.push(entry.id);
      else fromTags.set(entry.id, statusCode);
    }
    const contentById = await this.contentFor(missing);
    return entries.map((entry) => {
      const statusCode = fromTags.get(entry.id);
      if (statusCode !== undefined) return { ...entry, content: { statusCode } };
      return { ...entry, content: contentById.get(entry.id) ?? null };
    });
  }

  /** Content of the given ids, read in batched `ids` queries. */
  private async contentFor(ids: string[]): Promise<Map<string, unknown>> {
    const contentById = new Map<string, unknown>();
    for (let offset = 0; offset < ids.length; offset += HYDRATE_CHUNK) {
      const chunk = ids.slice(offset, offset + HYDRATE_CHUNK);
      const page = await this.storage.get({ ids: chunk, limit: chunk.length });
      for (const entry of page.data) contentById.set(entry.id, entry.content);
    }
    return contentById;
  }

  /**
   * Queries the 1-minute latency-histogram rollups for `type` over the window,
   * merges them element-wise, and estimates p50/p95/p99. Returns `undefined`
   * when no histogram samples exist (total 0), so the latency block's shape and
   * the "no durations ⇒ no latency" behavior match the raw path.
   */
  private async estimatePercentiles(
    store: RollupStore,
    type: string,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<LatencyPercentilesOverride | undefined> {
    const fromBucket = floorToBucket(windowStart.getTime());
    const toBucket = floorToBucket(windowEnd.getTime());
    const rollups = await store.queryRollups([type], fromBucket, toBucket);

    const merged = emptyHistogram();
    let mergedMax = 0;
    for (const rollup of rollups) {
      mergeHistogramInto(merged, rollup.histogram);
      mergedMax = Math.max(mergedMax, rollup.max);
    }

    let total = 0;
    for (const count of merged) total += count;
    if (total === 0) return undefined;

    // The histogram estimate returns a bucket's UPPER boundary, which can exceed
    // the true maximum (e.g. one sample of 410ms lands in the <=500ms bucket and
    // estimates 500). Clamp to the rollup's exact `max` so a percentile is never
    // reported above the observed maximum — `p99 > max` reads as a bug to users.
    return {
      p50: Math.min(estimatePercentileFromHistogram(merged, 0.5), mergedMax),
      p95: Math.min(estimatePercentileFromHistogram(merged, 0.95), mergedMax),
      p99: Math.min(estimatePercentileFromHistogram(merged, 0.99), mergedMax),
    };
  }
}

/** The status code of the row's only `status:<code>` tag, or null when it has
 *  none, several, or one that is not a number the status tagger would emit. */
function statusFromTags(tags: string[]): number | null {
  let found: number | null = null;
  for (const tag of tags) {
    if (!tag.startsWith(STATUS_TAG_PREFIX)) continue;
    if (found !== null) return null;
    const raw = tag.slice(STATUS_TAG_PREFIX.length);
    const value = Number(raw);
    if (raw === '' || String(value) !== raw) return null;
    found = value;
  }
  return found;
}

/** Folds `addend` into `target` in place via the canonical element-wise merge. */
function mergeHistogramInto(target: number[], addend: number[]): void {
  const merged = mergeHistograms(target, addend);
  for (let index = 0; index < merged.length; index += 1) {
    target[index] = merged[index] ?? 0;
  }
}
