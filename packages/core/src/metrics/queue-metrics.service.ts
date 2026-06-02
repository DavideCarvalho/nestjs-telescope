// packages/core/src/metrics/queue-metrics.service.ts
import { Inject, Injectable, Optional } from '@nestjs/common';
import { TELESCOPE_STORAGE } from '../nest/telescope.options.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { collectEntriesInWindow } from './collect-window.js';
import { type QueueMetricsReport, aggregateQueueMetrics } from './queue-metrics.js';

const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_SCAN_CAP = 50_000;

export interface QueueMetricsServiceOptions {
  /** Entries fetched per storage page. Default 500. */
  pageSize?: number;
  /** Safety cap on entries scanned per request; surfaced via `truncated`. Default 50_000. */
  scanCap?: number;
}

export interface QueueMetricsResult extends QueueMetricsReport {
  /** Number of job entries aggregated. */
  scanned: number;
  /** True if the scan hit the cap (older jobs in the window were not counted). */
  truncated: boolean;
}

/** Computes queue metrics by aggregating stored `job` entries over a time
 *  window. Reads the store (source of truth) on demand — no live counters, so
 *  it is correct across restarts and replicas. */
@Injectable()
export class QueueMetricsService {
  private readonly pageSize: number;
  private readonly scanCap: number;

  constructor(
    @Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider,
    @Optional() options?: QueueMetricsServiceOptions,
  ) {
    this.pageSize = options?.pageSize ?? DEFAULT_PAGE_SIZE;
    this.scanCap = options?.scanCap ?? DEFAULT_SCAN_CAP;
  }

  async getQueueMetrics(windowMs: number): Promise<QueueMetricsResult> {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError(`windowMs must be a positive, finite number (got ${windowMs}).`);
    }
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - windowMs);

    const { entries, scanned, truncated } = await collectEntriesInWindow(
      this.storage,
      { type: 'job', after: windowStart },
      { pageSize: this.pageSize, scanCap: this.scanCap },
    );

    const report = aggregateQueueMetrics(entries, windowStart, windowEnd);
    return { ...report, scanned, truncated };
  }
}
