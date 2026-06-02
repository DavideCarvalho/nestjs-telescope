// packages/core/src/pulse/pulse.service.ts
import { Inject, Injectable, Optional } from '@nestjs/common';
import { collectEntriesInWindow } from '../metrics/collect-window.js';
import { TELESCOPE_STORAGE } from '../nest/telescope.options.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { type PulseSummary, summarizePulse } from './pulse-summary.js';

const DEFAULT_TOP_N = 5;
const DEFAULT_N_PLUS_ONE_THRESHOLD = 5;

export interface PulseServiceOptions {
  pageSize?: number;
  scanCap?: number;
  /** How many slowest entries / exception groups / N+1 occurrences to return. Default 5. */
  topN?: number;
  /** Min repetitions of one query template in a batch to flag N+1. Default 5. */
  nPlusOneThreshold?: number;
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

  constructor(
    @Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider,
    @Optional() options?: PulseServiceOptions,
  ) {
    this.pageSize = options?.pageSize;
    this.scanCap = options?.scanCap;
    this.topN = options?.topN ?? DEFAULT_TOP_N;
    this.nPlusOneThreshold = options?.nPlusOneThreshold ?? DEFAULT_N_PLUS_ONE_THRESHOLD;
  }

  async getHealth(windowMs: number): Promise<PulseResult> {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError(`windowMs must be a positive, finite number (got ${windowMs}).`);
    }
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - windowMs);

    const { entries, scanned, truncated } = await collectEntriesInWindow(
      this.storage,
      { after: windowStart },
      {
        ...(this.pageSize !== undefined ? { pageSize: this.pageSize } : {}),
        ...(this.scanCap !== undefined ? { scanCap: this.scanCap } : {}),
      },
    );

    const summary = summarizePulse(entries, windowStart, windowEnd, {
      topN: this.topN,
      nPlusOneThreshold: this.nPlusOneThreshold,
    });
    return { ...summary, scanned, truncated };
  }
}
