// packages/core/src/metrics/timeseries.service.ts
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EntryType } from '../entry/entry.js';
import { TELESCOPE_STORAGE } from '../nest/telescope.options.js';
import { type RollupStore, floorToBucket, isRollupStore } from '../rollup/rollup-store.js';
import type { EntryQuery, StorageProvider } from '../storage/storage-provider.js';
import { ScopedAggregateUnsupported } from '../storage/tenant-scoped-storage.js';
import { collectEntriesInWindow } from './collect-window.js';
import { timeseriesFromRollups } from './timeseries-from-rollups.js';
import {
  type TimeseriesReport,
  bucketGeometry,
  bucketTimeseries,
  timeseriesFromCounts,
} from './timeseries.js';

/** Metric universe queried when no explicit `type` filter is supplied. */
const BUILTIN_METRICS: string[] = Object.values(EntryType);

const DEFAULT_BUCKETS = 60;
const MAX_BUCKETS = 500;

export interface TimeseriesQuery {
  windowMs: number;
  buckets?: number;
  type?: string;
  tag?: string;
}

export interface TimeseriesServiceOptions {
  pageSize?: number;
  scanCap?: number;
}

export interface TimeseriesResult extends TimeseriesReport {
  scanned: number;
  truncated: boolean;
}

/** Computes a throughput time-series by aggregating stored entries over a
 *  window. Reads the store on demand — no separate time-series capture. */
@Injectable()
export class TimeseriesService {
  private readonly pageSize: number | undefined;
  private readonly scanCap: number | undefined;
  private readonly logger = new Logger('TelescopeTimeseries');

  constructor(
    @Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider,
    @Optional() options?: TimeseriesServiceOptions,
  ) {
    this.pageSize = options?.pageSize;
    this.scanCap = options?.scanCap;
  }

  async getTimeseries(query: TimeseriesQuery): Promise<TimeseriesResult> {
    if (!Number.isFinite(query.windowMs) || query.windowMs <= 0) {
      throw new RangeError(`windowMs must be a positive, finite number (got ${query.windowMs}).`);
    }
    const buckets = Math.min(
      MAX_BUCKETS,
      Math.max(1, Math.floor(query.buckets ?? DEFAULT_BUCKETS)),
    );
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - query.windowMs);

    // Fast path: read pre-aggregated rollups when the store supports them and
    // the query is rollup-answerable (no tag filter — rollups aggregate across
    // tags). Falls through to the raw scan otherwise; the output matches.
    if (isRollupStore(this.storage) && query.tag === undefined) {
      return this.fromRollups(this.storage, query, windowStart, windowEnd, buckets);
    }

    const counted = await this.fromAggregate(query, windowStart, windowEnd, buckets);
    if (counted !== null) return counted;

    const baseQuery: Omit<EntryQuery, 'cursor' | 'limit'> = {
      after: windowStart,
      // bucketTimeseries only reads createdAt + type, so scan content-less.
      omitContent: true,
      ...(query.type !== undefined ? { type: query.type } : {}),
      ...(query.tag !== undefined ? { tag: query.tag } : {}),
    };
    const { entries, scanned, truncated } = await collectEntriesInWindow(this.storage, baseQuery, {
      ...(this.pageSize !== undefined ? { pageSize: this.pageSize } : {}),
      ...(this.scanCap !== undefined ? { scanCap: this.scanCap } : {}),
    });

    const report = bucketTimeseries(entries, windowStart, windowEnd, buckets);
    return { ...report, scanned, truncated };
  }

  /**
   * Counted by the store (a SQL store's GROUP BY over type and bucket), when it aggregates: the
   * same buckets as {@link bucketTimeseries}, nothing truncated. `null` when it does not, or when
   * the aggregation failed (then the window is scanned).
   */
  private async fromAggregate(
    query: TimeseriesQuery,
    windowStart: Date,
    windowEnd: Date,
    buckets: number,
  ): Promise<TimeseriesResult | null> {
    const storage = this.storage;
    if (typeof storage.aggregate !== 'function') return null;
    // The same geometry as bucketTimeseries.
    const { startMs, bucketMs } = bucketGeometry(windowStart, windowEnd, buckets);
    try {
      const result = await storage.aggregate({
        kind: 'count',
        window: {
          after: windowStart,
          ...(query.type !== undefined ? { type: query.type } : {}),
          ...(query.tag !== undefined ? { tag: query.tag } : {}),
        },
        bucket: { startMs, widthMs: bucketMs },
      });
      if (result.kind !== 'count') throw new Error(`aggregate(count) answered ${result.kind}`);
      return {
        ...timeseriesFromCounts(result.rows, windowStart, windowEnd, buckets),
        truncated: false,
      };
    } catch (error) {
      if (error instanceof ScopedAggregateUnsupported) return null;
      this.logger.warn(
        `the store could not aggregate the timeseries, scanning instead: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Rollup-backed assembly. Queries the 1-minute rollup buckets covering the
   * window for the relevant metrics (the single `type` if filtered, else the
   * builtin metric universe) and re-buckets them into the report's requested
   * `buckets`. `scanned` reflects the number of rollup rows read; rollups never
   * truncate (they are bounded by minute granularity, not raw volume).
   */
  private async fromRollups(
    store: RollupStore,
    query: TimeseriesQuery,
    windowStart: Date,
    windowEnd: Date,
    buckets: number,
  ): Promise<TimeseriesResult> {
    const metrics = query.type !== undefined ? [query.type] : BUILTIN_METRICS;
    const fromBucket = floorToBucket(windowStart.getTime());
    const toBucket = floorToBucket(windowEnd.getTime());
    const rollups = await store.queryRollups(metrics, fromBucket, toBucket);
    const report = timeseriesFromRollups(rollups, windowStart, windowEnd, buckets);
    return { ...report, scanned: rollups.length, truncated: false };
  }
}
