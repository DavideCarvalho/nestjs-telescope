// packages/core/src/metrics/queue-metrics.service.ts
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Entry } from '../entry/entry.js';
import { TELESCOPE_STORAGE } from '../nest/telescope.options.js';
import type { EntryQuery, StorageProvider } from '../storage/storage-provider.js';
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

    const entries: Entry[] = [];
    let cursor: string | undefined;
    let truncated = false;
    for (;;) {
      const query: EntryQuery = {
        type: 'job',
        after: windowStart,
        limit: this.pageSize,
        ...(cursor !== undefined ? { cursor } : {}),
      };
      const page = await this.storage.get(query);
      // No progress: an empty page means nothing more to read, even if a
      // non-compliant store still returns a cursor. Guards against an infinite
      // loop that SCAN_CAP cannot catch (entries.length would never grow).
      if (page.data.length === 0) break;
      entries.push(...page.data);
      if (entries.length >= this.scanCap) {
        truncated = true;
        break;
      }
      // The cursor must advance, or we'd re-read the same page forever.
      if (page.nextCursor === null || page.nextCursor === cursor) break;
      cursor = page.nextCursor;
    }

    const scanned = Math.min(entries.length, this.scanCap);
    const report = aggregateQueueMetrics(entries.slice(0, this.scanCap), windowStart, windowEnd);
    return { ...report, scanned, truncated };
  }
}
