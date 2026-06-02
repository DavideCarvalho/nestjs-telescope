// packages/core/src/metrics/queue-metrics.service.ts
import { Inject, Injectable } from '@nestjs/common';
import type { Entry } from '../entry/entry.js';
import { TELESCOPE_STORAGE } from '../nest/telescope.options.js';
import type { EntryQuery, StorageProvider } from '../storage/storage-provider.js';
import { type QueueMetricsReport, aggregateQueueMetrics } from './queue-metrics.js';

/** Entries fetched per storage page. */
const PAGE_SIZE = 500;
/** Safety cap on entries scanned per request; surfaced via `truncated`. */
const SCAN_CAP = 50_000;

export interface QueueMetricsResult extends QueueMetricsReport {
  /** Number of job entries aggregated. */
  scanned: number;
  /** True if the scan hit `SCAN_CAP` (older jobs in the window were not counted). */
  truncated: boolean;
}

/** Computes queue metrics by aggregating stored `job` entries over a time
 *  window. Reads the store (source of truth) on demand — no live counters, so
 *  it is correct across restarts and replicas. */
@Injectable()
export class QueueMetricsService {
  constructor(@Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider) {}

  async getQueueMetrics(windowMs: number): Promise<QueueMetricsResult> {
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - windowMs);

    const entries: Entry[] = [];
    let cursor: string | undefined;
    let truncated = false;
    for (;;) {
      const query: EntryQuery = {
        type: 'job',
        after: windowStart,
        limit: PAGE_SIZE,
        ...(cursor !== undefined ? { cursor } : {}),
      };
      const page = await this.storage.get(query);
      entries.push(...page.data);
      if (entries.length >= SCAN_CAP) {
        truncated = true;
        break;
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    const scanned = Math.min(entries.length, SCAN_CAP);
    const report = aggregateQueueMetrics(entries.slice(0, SCAN_CAP), windowStart, windowEnd);
    return { ...report, scanned, truncated };
  }
}
