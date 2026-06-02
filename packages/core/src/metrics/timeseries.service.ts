// packages/core/src/metrics/timeseries.service.ts
import { Inject, Injectable, Optional } from '@nestjs/common';
import { TELESCOPE_STORAGE } from '../nest/telescope.options.js';
import type { EntryQuery, StorageProvider } from '../storage/storage-provider.js';
import { collectEntriesInWindow } from './collect-window.js';
import { type TimeseriesReport, bucketTimeseries } from './timeseries.js';

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

    const baseQuery: Omit<EntryQuery, 'cursor' | 'limit'> = {
      after: windowStart,
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
}
