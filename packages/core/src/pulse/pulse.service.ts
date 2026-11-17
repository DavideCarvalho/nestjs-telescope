// packages/core/src/pulse/pulse.service.ts
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { collectEntriesInWindow } from '../metrics/collect-window.js';
import { type TimeseriesReport, bucketTimeseries } from '../metrics/timeseries.js';
import { TELESCOPE_STORAGE } from '../nest/telescope.options.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { ScopedAggregateUnsupported } from '../storage/tenant-scoped-storage.js';
import {
  PULSE_CARDS,
  type PulseCard,
  type PulsePlan,
  aggregatePulseInStore,
} from './pulse-from-store.js';
import {
  type PulseAggregates,
  type PulseSummary,
  aggregatePulse,
  finalizePulse,
} from './pulse-summary.js';

const DEFAULT_TOP_N = 5;
const DEFAULT_N_PLUS_ONE_THRESHOLD = 5;
const DEFAULT_SLOW_ROUTE_MIN_COUNT = 1;
/**
 * Default p99 (ms) a route must reach to count as a slow-route hotspot. Matches
 * the `slow` request-tag threshold (`SLOW_THRESHOLD_MS` in tagging/tagger.ts)
 * and the HttpClientWatcher `slowMs` default, so "hotspot" lines up with the
 * `slow` tag used everywhere else. See {@link PulseOptions.slowRouteMs}.
 */
const DEFAULT_SLOW_ROUTE_MS = 1000;

export interface PulseServiceOptions {
  pageSize?: number;
  scanCap?: number;
  /** How many slowest entries / exception groups / N+1 occurrences to return. Default 5. */
  topN?: number;
  /** Min repetitions of one query template in a batch to flag N+1. Default 5. */
  nPlusOneThreshold?: number;
  /** Min request count for a route to qualify as a slow-route hotspot. Default 1. */
  slowRouteMinCount?: number;
  /**
   * Min p99 (ms) for a route to count as a slow-route hotspot — a route only
   * surfaces in "Slow request hotspots" when its p99 is **>= slowRouteMs**.
   * Default 1000, matching the `slow` request-tag threshold so a "hotspot"
   * means the same thing as the `slow` tag. Lower it on a latency-sensitive
   * service; raise it to only flag egregious routes.
   */
  slowRouteMs?: number;
}

export interface PulseResult extends PulseSummary {
  scanned: number;
  truncated: boolean;
  /**
   * The throughput over the window (the same report as `GET timeseries`), when the read asked for
   * `buckets`: taken from the counts' read, so a page showing both reads the window once.
   */
  timeseries?: TimeseriesReport;
}

/** What one {@link PulseService.getHealth} read computes besides the counts. */
export interface PulseReadOptions {
  /**
   * Only these cards (of {@link PULSE_CARDS}; unknown names are ignored, none left means all), so
   * a page showing a few of them skips the reads the others need. The others come back empty.
   */
  cards?: readonly string[];
  /** Also the throughput over the window in this many buckets (1..500), from the same read. */
  buckets?: number;
}

const MAX_BUCKETS = 500;

/** `asked` narrowed to the known cards; `undefined` (every card) when none is left. */
function cardsOf(asked: readonly string[] | undefined): ReadonlySet<PulseCard> | undefined {
  if (asked === undefined) return undefined;
  const known = new Set<string>(PULSE_CARDS);
  const cards = new Set(asked.filter((card): card is PulseCard => known.has(card)));
  return cards.size > 0 ? cards : undefined;
}

/** `aggregates` with the cards not asked for emptied (nothing of theirs is hydrated either). */
function narrowAggregates(
  aggregates: PulseAggregates,
  cards: ReadonlySet<PulseCard> | undefined,
): PulseAggregates {
  if (cards === undefined) return aggregates;
  const keep = <T>(card: PulseCard, rows: T[]): T[] => (cards.has(card) ? rows : []);
  const slowest = keep('slowest', aggregates.slowest);
  const exceptions = keep('exceptions', aggregates.exceptions);
  const nPlusOne = keep('nPlusOne', aggregates.nPlusOne);
  return {
    ...aggregates,
    slowest,
    exceptions,
    nPlusOne,
    slowRoutes: keep('slowRoutes', aggregates.slowRoutes),
    slowOutgoing: keep('slowOutgoing', aggregates.slowOutgoing),
    slowJobs: keep('slowJobs', aggregates.slowJobs),
    slowWork: keep('slowJobs', aggregates.slowWork),
    loadByUser: keep('loadByUser', aggregates.loadByUser),
    hydrationIds: {
      slowest: slowest.map((candidate) => candidate.id),
      exceptions: exceptions.map((group) => group.representativeId),
      nPlusOne: nPlusOne.map((hotspot) => hotspot.representativeId),
    },
  };
}

/** Pass 1 of a Pulse read: the aggregates, how many entries they cover, and the series asked for. */
interface PulseRead {
  aggregates: PulseAggregates;
  scanned: number;
  truncated: boolean;
  timeseries?: TimeseriesReport;
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
  private readonly slowRouteMs: number;
  private readonly logger = new Logger('TelescopePulse');

  constructor(
    @Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider,
    @Optional() options?: PulseServiceOptions,
  ) {
    this.pageSize = options?.pageSize;
    this.scanCap = options?.scanCap;
    this.topN = options?.topN ?? DEFAULT_TOP_N;
    this.nPlusOneThreshold = options?.nPlusOneThreshold ?? DEFAULT_N_PLUS_ONE_THRESHOLD;
    this.slowRouteMinCount = options?.slowRouteMinCount ?? DEFAULT_SLOW_ROUTE_MIN_COUNT;
    this.slowRouteMs = options?.slowRouteMs ?? DEFAULT_SLOW_ROUTE_MS;
  }

  async getHealth(windowMs: number, read: PulseReadOptions = {}): Promise<PulseResult> {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError(`windowMs must be a positive, finite number (got ${windowMs}).`);
    }
    const cards = cardsOf(read.cards);
    const buckets =
      read.buckets !== undefined && Number.isFinite(read.buckets)
        ? Math.min(MAX_BUCKETS, Math.max(1, Math.floor(read.buckets)))
        : undefined;
    const plan: PulsePlan = {
      ...(cards !== undefined ? { cards } : {}),
      ...(buckets !== undefined ? { buckets } : {}),
    };
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - windowMs);

    const pulseOptions = {
      topN: this.topN,
      nPlusOneThreshold: this.nPlusOneThreshold,
      slowRouteMinCount: this.slowRouteMinCount,
      slowRouteMs: this.slowRouteMs,
    };
    const read1 =
      (await this.fromStore(windowStart, windowEnd, pulseOptions, plan)) ??
      (await this.fromScan(windowStart, windowEnd, pulseOptions, plan));
    const { scanned, truncated, timeseries } = read1;
    const aggregates = narrowAggregates(read1.aggregates, cards);

    // Pass 2: hydrate content for ONLY the handful of displayed rows — the top-N
    // slowest, one representative per reported exception family, and one per
    // reported N+1 family. Bounded by topN, so at most a few dozen reads.
    const contentById = await this.hydrate(aggregates.hydrationIds);
    const summary = finalizePulse(aggregates, (id) =>
      contentById.has(id) ? contentById.get(id) : undefined,
    );
    return { ...summary, scanned, truncated, ...(timeseries !== undefined ? { timeseries } : {}) };
  }

  /**
   * Pass 1 in the store, when it aggregates (a SQL store): a few GROUP BYs, nothing capped.
   * `null` when it does not, or when the aggregation failed (then the window is scanned).
   */
  private async fromStore(
    windowStart: Date,
    windowEnd: Date,
    options: Parameters<typeof aggregatePulse>[3],
    plan: PulsePlan,
  ): Promise<PulseRead | null> {
    const storage = this.storage;
    if (typeof storage.aggregate !== 'function') return null;
    try {
      const read = await aggregatePulseInStore(
        { aggregate: storage.aggregate.bind(storage), get: storage.get.bind(storage) },
        windowStart,
        windowEnd,
        options,
        plan,
      );
      return { ...read, truncated: false };
    } catch (error) {
      if (error instanceof ScopedAggregateUnsupported) return null;
      this.logger.warn(
        `the store could not aggregate pulse, scanning instead: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /** Pass 1 by scanning the whole window over content-less columns (bounded by `scanCap`). */
  private async fromScan(
    windowStart: Date,
    windowEnd: Date,
    options: Parameters<typeof aggregatePulse>[3],
    plan: PulsePlan,
  ): Promise<PulseRead> {
    const { entries, scanned, truncated } = await collectEntriesInWindow(
      this.storage,
      { after: windowStart, omitContent: true },
      {
        ...(this.pageSize !== undefined ? { pageSize: this.pageSize } : {}),
        ...(this.scanCap !== undefined ? { scanCap: this.scanCap } : {}),
      },
    );
    return {
      aggregates: aggregatePulse(entries, windowStart, windowEnd, options),
      scanned,
      truncated,
      ...(plan.buckets !== undefined
        ? { timeseries: bucketTimeseries(entries, windowStart, windowEnd, plan.buckets) }
        : {}),
    };
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
