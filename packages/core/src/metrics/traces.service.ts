// packages/core/src/metrics/traces.service.ts
import { Inject, Injectable, Optional } from '@nestjs/common';
import { TELESCOPE_STORAGE } from '../nest/telescope.options.js';
import type { EntryQuery, StorageProvider } from '../storage/storage-provider.js';
import { collectEntriesInWindow } from './collect-window.js';
import { type TraceSummary, summarizeTraces } from './traces.js';
import { type Waterfall, buildWaterfall } from './waterfall.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export interface TracesQuery {
  windowMs: number;
  limit?: number;
}

export interface TracesServiceOptions {
  pageSize?: number;
  scanCap?: number;
}

export interface TracesResult {
  traces: TraceSummary[];
  scanned: number;
  truncated: boolean;
}

/** Lists recent distinct OTel traces by grouping stored entries over a window.
 *  Reads the store on demand, content-less — mirrors TimeseriesService. */
@Injectable()
export class TracesService {
  private readonly pageSize: number | undefined;
  private readonly scanCap: number | undefined;

  constructor(
    @Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider,
    @Optional() options?: TracesServiceOptions,
  ) {
    this.pageSize = options?.pageSize;
    this.scanCap = options?.scanCap;
  }

  async getTraces(query: TracesQuery): Promise<TracesResult> {
    if (!Number.isFinite(query.windowMs) || query.windowMs <= 0) {
      throw new RangeError(`windowMs must be a positive, finite number (got ${query.windowMs}).`);
    }
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)));
    const windowStart = new Date(Date.now() - query.windowMs);

    const baseQuery: Omit<EntryQuery, 'cursor' | 'limit'> = {
      after: windowStart,
      // summarizeTraces only reads traceId/type/createdAt/durationMs, not content.
      omitContent: true,
    };
    const { entries, scanned, truncated } = await collectEntriesInWindow(this.storage, baseQuery, {
      ...(this.pageSize !== undefined ? { pageSize: this.pageSize } : {}),
      ...(this.scanCap !== undefined ? { scanCap: this.scanCap } : {}),
    });

    return { traces: summarizeTraces(entries, { limit }), scanned, truncated };
  }

  /**
   * Build a nested span waterfall for ONE trace. Fetches the trace's entries WITH
   * content (labels need it) and reconstructs parent/child nesting from time-
   * interval containment — see {@link buildWaterfall}. Returns `null` when the
   * trace has no entries (e.g. unknown / pruned trace id).
   */
  async getWaterfall(traceId: string): Promise<Waterfall | null> {
    const page = await this.storage.get({ traceId, limit: MAX_LIMIT });
    return buildWaterfall(page.data);
  }
}
