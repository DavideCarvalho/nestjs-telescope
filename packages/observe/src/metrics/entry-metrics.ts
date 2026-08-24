import { type RecordInput, isErrorEntry } from '@dudousxd/nestjs-telescope';
import type { Clock } from '../observe-options.js';
import { type WireCustomMetric, labelKey } from '../wire/telemetry-wire.js';

/** Cumulative entry count, split by entry type and whether the entry looks like a failure. */
const COUNTER_NAME = 'telescope.entries';
/** Per-interval latency distribution, by entry type. */
const SUMMARY_NAME = 'telescope.duration_ms';

const DEFAULT_MAX_SERIES_PER_METRIC = 1_000;
const DEFAULT_SAMPLE_SIZE = 512;

export interface EntryMetricsOptions {
  clock?: Clock;
  /** Ceiling on distinct label combinations per metric. Default 1000. */
  maxSeriesPerMetric?: number;
  /** Reservoir size backing each summary series. Default 512. */
  sampleSize?: number;
}

/** One counter series. `key` is built once, on creation, so `observe` never stringifies. */
interface CounterCell {
  readonly key: string;
  total: number;
  sinceCollect: number;
}

/** Both `failed` variants of one entry type, so the hot path does a single map lookup. */
interface CounterPair {
  ok?: CounterCell;
  failed?: CounterCell;
}

interface SummaryCell {
  readonly key: string;
  /** Observations in the current interval; also the `i` of Algorithm R. */
  count: number;
  sum: number;
  max: number;
  reservoir: number[];
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/** The collector validates every number, and one `NaN` fails the whole POST. */
function safe(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** Nearest-rank, over an ascending copy of the reservoir. */
function quantile(ascending: number[], q: number): number {
  const rank = Math.ceil(q * ascending.length) - 1;
  const index = Math.min(ascending.length - 1, Math.max(0, rank));
  return safe(ascending[index] as number);
}

function drainCounter(
  cell: CounterCell,
  value: Record<string, number>,
  increase: Record<string, number>,
): void {
  value[cell.key] = safe(cell.total);
  increase[cell.key] = safe(cell.sinceCollect);
  cell.sinceCollect = 0;
}

/**
 * Turns Telescope's `observeRecord` hook into Observe `custom[]` metrics.
 *
 * The hook fires for every record BEFORE sampling, unlike `observeFlush` which
 * only sees what survived it — so these counters describe the process rather
 * than the sample, and stay meaningful under an aggressive `sampling` config.
 *
 * Quantiles are computed here, from a bounded reservoir: the wire carries
 * `q50`/`q95`/`q99` only, so no raw observation ever leaves the process.
 */
export class EntryMetrics {
  private readonly clock: Clock;
  private readonly maxSeriesPerMetric: number;
  private readonly sampleSize: number;

  private readonly counters = new Map<string, CounterPair>();
  private readonly summaries = new Map<string, SummaryCell>();
  private counterSeries = 0;
  private summarySeries = 0;
  private dropped = 0;

  constructor(options: EntryMetricsOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.maxSeriesPerMetric = positive(options.maxSeriesPerMetric, DEFAULT_MAX_SERIES_PER_METRIC);
    this.sampleSize = positive(options.sampleSize, DEFAULT_SAMPLE_SIZE);
  }

  /** Observations refused because their series would have exceeded the ceiling. */
  get droppedSeries(): number {
    return this.dropped;
  }

  /** Runs once per recorded entry, in the caller's stack: map lookups and arithmetic only. */
  observe(input: RecordInput): void {
    this.count(input.type, isErrorEntry(input));
    const duration = input.durationMs;
    if (typeof duration === 'number' && Number.isFinite(duration)) {
      this.observeDuration(input.type, duration);
    }
  }

  /**
   * The metrics for this flush. The counter's `v` stays cumulative for the life
   * of the process while `iv` carries the interval's increase — Observe needs
   * both to draw a rate — whereas the summary describes this interval alone and
   * is reset here.
   */
  collect(): WireCustomMetric[] {
    const metrics: WireCustomMetric[] = [];
    const lastUpdated = this.clock();

    const counter = this.collectCounter(lastUpdated);
    if (counter !== undefined) metrics.push(counter);

    const summary = this.collectSummary(lastUpdated);
    if (summary !== undefined) metrics.push(summary);

    return metrics;
  }

  private collectCounter(lastUpdated: number): WireCustomMetric | undefined {
    if (this.counters.size === 0) return undefined;

    const value: Record<string, number> = {};
    const increase: Record<string, number> = {};
    for (const pair of this.counters.values()) {
      if (pair.ok !== undefined) drainCounter(pair.ok, value, increase);
      if (pair.failed !== undefined) drainCounter(pair.failed, value, increase);
    }

    return {
      n: COUNTER_NAME,
      t: 'counter',
      v: value,
      iv: increase,
      // Sorted, so the names line up with the order `labelKey` puts them in.
      l: ['failed', 'type'],
      d: 'Telescope entries recorded, by type and failure',
      lu: lastUpdated,
    };
  }

  private collectSummary(lastUpdated: number): WireCustomMetric | undefined {
    const value: Record<string, number> = {};
    const q50: Record<string, number> = {};
    const q95: Record<string, number> = {};
    const q99: Record<string, number> = {};
    const count: Record<string, number> = {};
    const sum: Record<string, number> = {};
    const max: Record<string, number> = {};
    let observed = false;

    for (const cell of this.summaries.values()) {
      if (cell.count === 0) continue;
      observed = true;

      const ascending = [...cell.reservoir].sort((a, b) => a - b);
      q50[cell.key] = quantile(ascending, 0.5);
      q95[cell.key] = quantile(ascending, 0.95);
      q99[cell.key] = quantile(ascending, 0.99);
      count[cell.key] = safe(cell.count);
      sum[cell.key] = safe(cell.sum);
      max[cell.key] = safe(cell.max);
      value[cell.key] = safe(cell.sum);

      cell.count = 0;
      cell.sum = 0;
      cell.max = Number.NEGATIVE_INFINITY;
      cell.reservoir.length = 0;
    }

    if (!observed) return undefined;

    return {
      n: SUMMARY_NAME,
      t: 'summary',
      v: value,
      q50,
      q95,
      q99,
      ct: count,
      sm: sum,
      mx: max,
      l: ['type'],
      d: 'Telescope entry duration by type',
      lu: lastUpdated,
    };
  }

  private count(type: string, failed: boolean): void {
    let pair = this.counters.get(type);
    if (pair !== undefined) {
      const cell = failed ? pair.failed : pair.ok;
      if (cell !== undefined) {
        cell.total += 1;
        cell.sinceCollect += 1;
        return;
      }
    }

    // A host may record an arbitrary `type`, so an unbounded map is a real leak.
    if (this.counterSeries >= this.maxSeriesPerMetric) {
      this.dropped += 1;
      return;
    }

    if (pair === undefined) {
      pair = {};
      this.counters.set(type, pair);
    }
    const created: CounterCell = {
      key: labelKey({ failed: failed ? 'true' : 'false', type }),
      total: 1,
      sinceCollect: 1,
    };
    if (failed) pair.failed = created;
    else pair.ok = created;
    this.counterSeries += 1;
  }

  private observeDuration(type: string, value: number): void {
    let cell = this.summaries.get(type);
    if (cell === undefined) {
      if (this.summarySeries >= this.maxSeriesPerMetric) {
        this.dropped += 1;
        return;
      }
      cell = {
        key: labelKey({ type }),
        count: 0,
        sum: 0,
        max: Number.NEGATIVE_INFINITY,
        reservoir: [],
      };
      this.summaries.set(type, cell);
      this.summarySeries += 1;
    }

    // Algorithm R, over the observations seen so far this interval. The reservoir
    // bounds memory but not accuracy of the aggregates: count, total and maximum
    // are tracked exactly, and only the quantiles are estimated.
    if (cell.reservoir.length < this.sampleSize) {
      cell.reservoir.push(value);
    } else {
      const index = Math.floor(Math.random() * (cell.count + 1));
      if (index < this.sampleSize) cell.reservoir[index] = value;
    }

    cell.count += 1;
    cell.sum += value;
    if (value > cell.max) cell.max = value;
  }
}
