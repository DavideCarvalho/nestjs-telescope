// packages/core/src/metrics/stats.service.ts
import { Inject, Injectable, Optional } from '@nestjs/common';
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

    const baseQuery: Omit<EntryQuery, 'cursor' | 'limit'> = {
      after: windowStart,
      type: query.type,
    };
    const { entries, truncated } = await collectEntriesInWindow(this.storage, baseQuery, {
      ...(this.pageSize !== undefined ? { pageSize: this.pageSize } : {}),
      ...(this.scanCap !== undefined ? { scanCap: this.scanCap } : {}),
    });

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
    for (const rollup of rollups) mergeHistogramInto(merged, rollup.histogram);

    let total = 0;
    for (const count of merged) total += count;
    if (total === 0) return undefined;

    return {
      p50: estimatePercentileFromHistogram(merged, 0.5),
      p95: estimatePercentileFromHistogram(merged, 0.95),
      p99: estimatePercentileFromHistogram(merged, 0.99),
    };
  }
}

/** Folds `addend` into `target` in place via the canonical element-wise merge. */
function mergeHistogramInto(target: number[], addend: number[]): void {
  const merged = mergeHistograms(target, addend);
  for (let index = 0; index < merged.length; index += 1) {
    target[index] = merged[index] ?? 0;
  }
}
