// packages/core/src/pulse/pulse.service.ts
import { Inject, Injectable, Optional } from '@nestjs/common';
import { collectEntriesInWindow } from '../metrics/collect-window.js';
import { TELESCOPE_STORAGE } from '../nest/telescope.options.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { type PulseSummary, aggregatePulse, finalizePulse } from './pulse-summary.js';

const DEFAULT_TOP_N = 5;
const DEFAULT_N_PLUS_ONE_THRESHOLD = 5;
const DEFAULT_SLOW_ROUTE_MIN_COUNT = 1;

export interface PulseServiceOptions {
  pageSize?: number;
  scanCap?: number;
  /** How many slowest entries / exception groups / N+1 occurrences to return. Default 5. */
  topN?: number;
  /** Min repetitions of one query template in a batch to flag N+1. Default 5. */
  nPlusOneThreshold?: number;
  /** Min request count for a route to qualify as a slow-route hotspot. Default 1. */
  slowRouteMinCount?: number;
}

export interface PulseResult extends PulseSummary {
  scanned: number;
  truncated: boolean;
}

/** Computes a health snapshot by aggregating stored entries over a time window.
 *  Reads the store (source of truth) on demand — no live counters. */
@Injectable()
export class PulseService {
  private readonly pageSize: number | undefined;
  private readonly scanCap: number | undefined;
  private readonly topN: number;
  private readonly nPlusOneThreshold: number;
  private readonly slowRouteMinCount: number;

  constructor(
    @Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider,
    @Optional() options?: PulseServiceOptions,
  ) {
    this.pageSize = options?.pageSize;
    this.scanCap = options?.scanCap;
    this.topN = options?.topN ?? DEFAULT_TOP_N;
    this.nPlusOneThreshold = options?.nPlusOneThreshold ?? DEFAULT_N_PLUS_ONE_THRESHOLD;
    this.slowRouteMinCount = options?.slowRouteMinCount ?? DEFAULT_SLOW_ROUTE_MIN_COUNT;
  }

  async getHealth(windowMs: number): Promise<PulseResult> {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError(`windowMs must be a positive, finite number (got ${windowMs}).`);
    }
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - windowMs);

    // Pass 1: scan the whole window over content-less columns only. This is the
    // heavy loop (every entry in the window), so omitting the content blob is
    // where the time is saved.
    const { entries, scanned, truncated } = await collectEntriesInWindow(
      this.storage,
      { after: windowStart, omitContent: true },
      {
        ...(this.pageSize !== undefined ? { pageSize: this.pageSize } : {}),
        ...(this.scanCap !== undefined ? { scanCap: this.scanCap } : {}),
      },
    );

    const aggregates = aggregatePulse(entries, windowStart, windowEnd, {
      topN: this.topN,
      nPlusOneThreshold: this.nPlusOneThreshold,
      slowRouteMinCount: this.slowRouteMinCount,
    });

    // Pass 2: hydrate content for ONLY the handful of displayed rows — the top-N
    // slowest, one representative per reported exception family, and one per
    // reported N+1 family. Bounded by topN, so at most a few dozen reads.
    const contentById = await this.hydrate(aggregates.hydrationIds);
    const summary = finalizePulse(aggregates, (id) =>
      contentById.has(id) ? contentById.get(id) : undefined,
    );
    return { ...summary, scanned, truncated };
  }

  /** Fetch content for the deduplicated set of ids the pulse output displays. */
  private async hydrate(ids: {
    slowest: string[];
    exceptions: string[];
    nPlusOne: string[];
  }): Promise<Map<string, unknown>> {
    const uniqueIds = new Set<string>([...ids.slowest, ...ids.exceptions, ...ids.nPlusOne]);
    uniqueIds.delete('');
    const contentById = new Map<string, unknown>();
    if (uniqueIds.size === 0) return contentById;

    // ONE batched query for every displayed id, instead of N per-id find() round-
    // trips. Each find() hit the remote DB separately; this collapses them into a
    // single fetch (e.g. `id IN (...)` / MGET) — the pulse latency win on a remote
    // store. `limit` is sized to the id count so the page can hold all of them.
    const idList = [...uniqueIds];
    const page = await this.storage.get({ ids: idList, limit: idList.length });
    for (const entry of page.data) {
      contentById.set(entry.id, entry.content);
    }
    return contentById;
  }
}
