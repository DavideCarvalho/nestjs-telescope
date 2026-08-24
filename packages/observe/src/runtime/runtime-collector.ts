import {
  constants,
  type EventLoopUtilization,
  type IntervalHistogram,
  type PerformanceEntry,
  PerformanceObserver,
  type PerformanceObserverEntryList,
  monitorEventLoopDelay,
  performance,
} from 'node:perf_hooks';
import type { Clock, ExporterLogger } from '../observe-options.js';
import type { WireRuntimeMetrics } from '../wire/telemetry-wire.js';

export interface RuntimeCollectorOptions {
  clock?: Clock;
  logger?: ExporterLogger;
}

/**
 * Sampling period of the event-loop delay histogram, ms. Ten is Node's own
 * suggestion: fine enough to catch a stalled tick, coarse enough that the timer
 * itself is not what the histogram measures.
 */
const EVENT_LOOP_RESOLUTION_MS = 10;

interface GcTotals {
  count: number;
  totalMs: number;
  minor: number;
  major: number;
  incremental: number;
}

function emptyGcTotals(): GcTotals {
  return { count: 0, totalMs: 0, minor: 0, major: 0, incremental: 0 };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function toInt(value: number): number {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

/** `detail` is absent from the base `PerformanceEntry` type and only present on GC entries. */
function gcKind(entry: PerformanceEntry): number | undefined {
  const detail = (entry as PerformanceEntry & { detail?: unknown }).detail;
  if (typeof detail !== 'object' || detail === null) return undefined;
  const kind = (detail as { kind?: unknown }).kind;
  return typeof kind === 'number' ? kind : undefined;
}

/**
 * Fills the `runtime` section of a telemetry batch from Node's own instruments.
 *
 * Owns no timer: the exporter calls {@link RuntimeCollector.collect} on its
 * flush schedule, and each call both returns the interval since the previous
 * call and becomes the origin of the next one.
 */
export class RuntimeCollector {
  private readonly clock: Clock;
  private readonly logger: ExporterLogger | undefined;

  private started = false;
  private intervalStartedAt = 0;
  private lastCpu: NodeJS.CpuUsage | undefined;
  private lastElu: EventLoopUtilization | undefined;
  private histogram: IntervalHistogram | undefined;
  private gcObserver: PerformanceObserver | undefined;
  private gc: GcTotals = emptyGcTotals();
  private readonly warned = new Set<string>();

  constructor(options: RuntimeCollectorOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.logger = options.logger;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    this.intervalStartedAt = this.clock();
    this.gc = emptyGcTotals();
    this.lastCpu = this.probe('cpu', () => process.cpuUsage());
    this.lastElu = this.probe('eventLoopUtilization', () => performance.eventLoopUtilization());

    this.histogram = this.probe('eventLoopDelay', () => {
      const histogram = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS });
      histogram.enable();
      // Not on every release line, so it is called only where it exists — the
      // sampling timer must never be a reason the process stays alive.
      (histogram as IntervalHistogram & { unref?: () => void }).unref?.();
      return histogram;
    });

    this.gcObserver = this.probe('gc', () => {
      const observer = new PerformanceObserver(this.onGcEntries);
      // Buffered delivery would replay entries from before `start()` into the
      // first interval and attribute them to it.
      observer.observe({ entryTypes: ['gc'], buffered: false });
      return observer;
    });
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;

    this.probe('gc', () => this.gcObserver?.disconnect());
    this.probe('eventLoopDelay', () => this.histogram?.disable());
    this.gcObserver = undefined;
    this.histogram = undefined;
    this.lastCpu = undefined;
    this.lastElu = undefined;
    this.gc = emptyGcTotals();
  }

  private warnedPartial = false;

  collect(): WireRuntimeMetrics | null {
    if (!this.started) return null;

    const now = this.clock();
    // On the first collect the interval runs from `start()`, which is where the
    // CPU and event-loop-utilization baselines were taken.
    const elapsedMs = Math.max(0, now - this.intervalStartedAt);
    this.intervalStartedAt = now;

    const c = this.collectCpu(elapsedMs);
    const m = this.collectMemory();
    const g = this.collectGc();
    const e = this.collectEventLoop();

    // All four or nothing. Observe's collector answers 500 — not a validation
    // 400 — to a `runtime` object missing any sub-section, an empty one
    // included, so a partial snapshot is not a degraded report but a failed
    // POST. Returning null lets the caller retry on the next flush, which is
    // what gets the first snapshot out: the event-loop histogram has no mean
    // until it has taken a sample.
    if (c === undefined || m === undefined || g === undefined || e === undefined) {
      this.warnOncePartial();
      return null;
    }

    return { c, m, g, e };
  }

  /** One line however long the runtime stays unmeasurable, not one per flush. */
  private warnOncePartial(): void {
    if (this.warnedPartial) return;
    this.warnedPartial = true;
    this.logger?.warn(
      'runtime metrics incomplete, section withheld — Observe rejects a partial `runtime`',
    );
  }

  private collectCpu(elapsedMs: number): WireRuntimeMetrics['c'] {
    const previous = this.lastCpu;
    const delta = this.probe('cpu', () => process.cpuUsage(previous));
    if (!delta) return undefined;

    // `cpuUsage(previous)` already returns the difference, so the next baseline
    // is the sum rather than a second reading of a clock that has moved on.
    this.lastCpu = previous
      ? { user: previous.user + delta.user, system: previous.system + delta.system }
      : delta;

    const user = Math.max(0, toInt(delta.user));
    const system = Math.max(0, toInt(delta.system));
    // Not clamped at the top: a process on four busy cores really did spend
    // 400% of the wall clock on CPU, and flattening that to 100 hides the
    // saturation the Profiler exists to show.
    const percentage = elapsedMs > 0 ? Math.max(0, ((user + system) / 1000 / elapsedMs) * 100) : 0;

    return { u: user, s: system, p: round2(percentage) };
  }

  private collectMemory(): WireRuntimeMetrics['m'] {
    const usage = this.probe('memory', () => process.memoryUsage());
    if (!usage) return undefined;

    const heapTotal = toInt(usage.heapTotal);
    const heapUsed = toInt(usage.heapUsed);

    return {
      r: toInt(usage.rss),
      ht: heapTotal,
      hu: heapUsed,
      e: toInt(usage.external),
      ab: toInt(usage.arrayBuffers),
      p: heapTotal > 0 ? round2((heapUsed / heapTotal) * 100) : 0,
    };
  }

  /**
   * Only reported while the observer is attached. Zeros here are a measurement —
   * an interval in which nothing was collected — whereas the absent section
   * means the runtime refused the probe, and the two must stay distinguishable.
   */
  private collectGc(): WireRuntimeMetrics['g'] {
    if (!this.gcObserver) return undefined;

    const { count, totalMs, minor, major, incremental } = this.gc;
    this.gc = emptyGcTotals();

    return {
      c: count,
      td: round2(totalMs),
      b: { m: minor, j: major, i: incremental },
    };
  }

  private collectEventLoop(): WireRuntimeMetrics['e'] {
    const lag = this.collectLag();
    const utilization = this.collectUtilization();
    // The wire shape makes both fields mandatory, so half a measurement would
    // have to be padded with an invented number for the other half.
    if (lag === undefined || utilization === undefined) return undefined;
    return { l: lag, u: utilization };
  }

  private collectLag(): number | undefined {
    const histogram = this.histogram;
    if (!histogram) return undefined;

    return this.probe('eventLoopDelay', () => {
      const mean = histogram.mean;
      // Resetting keeps every snapshot describing its own interval instead of
      // an average that flattens further with every flush.
      histogram.reset();
      // `mean` is NaN until the histogram has taken a sample, which an interval
      // shorter than the sampling resolution never gives it.
      if (!Number.isFinite(mean) || mean < 0) return undefined;
      return round2(mean / 1e6);
    });
  }

  private collectUtilization(): number | undefined {
    return this.probe('eventLoopUtilization', () => {
      const current = performance.eventLoopUtilization();
      const previous = this.lastElu;
      const delta = previous ? performance.eventLoopUtilization(current, previous) : current;
      this.lastElu = current;
      const utilization = delta.utilization;
      if (!Number.isFinite(utilization)) return undefined;
      return round2(Math.min(1, Math.max(0, utilization)));
    });
  }

  private readonly onGcEntries = (list: PerformanceObserverEntryList): void => {
    for (const entry of list.getEntries()) {
      const duration = entry.duration;
      if (!Number.isFinite(duration) || duration < 0) continue;

      this.gc.count += 1;
      this.gc.totalMs += duration;

      // A weak-callback pass counts towards the totals but has no slot in the
      // breakdown, which the dashboard renders as three bars.
      switch (gcKind(entry)) {
        case constants.NODE_PERFORMANCE_GC_MINOR:
          this.gc.minor += 1;
          break;
        case constants.NODE_PERFORMANCE_GC_MAJOR:
          this.gc.major += 1;
          break;
        case constants.NODE_PERFORMANCE_GC_INCREMENTAL:
          this.gc.incremental += 1;
          break;
        default:
          break;
      }
    }
  };

  /**
   * Runs one platform reading. A runtime that refuses the instrument costs the
   * section it feeds, never the flush: the exporter has a batch to ship either
   * way, and a probe that fails once will fail every interval, so it is reported
   * on its first failure only.
   */
  private probe<T>(name: string, read: () => T): T | undefined {
    try {
      return read();
    } catch (error) {
      if (!this.warned.has(name)) {
        this.warned.add(name);
        const reason = error instanceof Error ? error.message : String(error);
        this.logger?.warn(`runtime ${name} metrics unavailable: ${reason}`);
      }
      return undefined;
    }
  }
}
