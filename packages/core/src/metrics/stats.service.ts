// packages/core/src/metrics/stats.service.ts
import { Inject, Injectable, Optional } from '@nestjs/common';
import { TELESCOPE_STORAGE } from '../nest/telescope.options.js';
import type { EntryQuery, StorageProvider } from '../storage/storage-provider.js';
import { collectEntriesInWindow } from './collect-window.js';
import { type StatsResult, summarizeStats } from './stats.js';

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

    return summarizeStats({
      entries,
      type: query.type,
      windowStart,
      windowEnd,
      windowMs: query.windowMs,
      buckets,
      slowMs: this.slowMs,
      truncated,
    });
  }
}
