import { EntryType, type RecordInput } from '@dudousxd/nestjs-telescope';

export interface MetricSample {
  counter: string;
  labels: Record<string, string>;
  durationMs: number | null;
  /** When set, also feed `durationMs` into this histogram/summary. */
  durationMetric?: string;
}

/** Pure: RecordInput -> the metric it contributes, or null if not exported. */
export function mapInput(input: RecordInput): MetricSample | null {
  const c = (input.content ?? {}) as Record<string, unknown>;
  const dur = input.durationMs ?? null;
  switch (input.type) {
    case EntryType.Request:
      return {
        counter: 'telescope_requests_total',
        labels: { method: String(c.method ?? ''), status: String(c.statusCode ?? '') },
        durationMs: dur,
        durationMetric: 'telescope_request_duration_ms',
      };
    case EntryType.Query:
      return {
        counter: 'telescope_queries_total',
        labels: { db: String(c.connection ?? c.db ?? 'default') },
        durationMs: dur,
        durationMetric: 'telescope_query_duration_ms',
      };
    case EntryType.Job:
      return {
        counter: 'telescope_jobs_total',
        labels: { status: String(c.status ?? (c.failed ? 'failed' : 'completed')) },
        durationMs: dur,
        durationMetric: 'telescope_job_duration_ms',
      };
    case EntryType.Exception:
    case EntryType.ClientException:
      return {
        counter: 'telescope_exceptions_total',
        labels: { class: String(c.class ?? c.name ?? 'Error') },
        durationMs: null,
      };
    case EntryType.Cache:
      return {
        counter: 'telescope_cache_total',
        labels: { result: c.hit === true ? 'hit' : c.hit === false ? 'miss' : 'write' },
        durationMs: null,
      };
    case EntryType.HttpClient:
      return {
        counter: 'telescope_http_client_total',
        labels: { host: String(c.host ?? ''), status: String(c.statusCode ?? '') },
        durationMs: dur,
        durationMetric: 'telescope_http_client_duration_ms',
      };
    case 'diagnostic':
      return {
        counter: 'telescope_diagnostic_total',
        labels: { lib: String(c.lib ?? ''), event: String(c.event ?? '') },
        durationMs: null,
      };
    default:
      return null;
  }
}

/**
 * Default cumulative histogram upper bounds (milliseconds) for duration metrics.
 * Shared with the OTel Meter side so the Prometheus scrape and OTLP push agree.
 */
export const DEFAULT_DURATION_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

export interface MetricStoreOptions {
  /**
   * Max distinct label-series kept per metric name. Once a metric reaches this
   * many series, NEW label combinations are dropped (existing series keep
   * updating — counters must never reset) and counted under
   * `telescope_metrics_dropped_series_total{metric}` so the loss is visible in
   * the scrape instead of becoming a silent unbounded-memory leak. Default 2000.
   */
  maxSeriesPerMetric?: number;
  /** Cumulative histogram upper bounds (ms) for duration metrics. */
  durationBucketsMs?: number[];
}

interface CounterSeries { labels: Record<string, string>; count: number }
interface HistogramSeries { labels: Record<string, string>; sum: number; count: number; buckets: number[] }

/** Dependency-free internal aggregation for the Prometheus `/metrics` scrape. */
export class MetricStore {
  private readonly counters = new Map<string, Map<string, CounterSeries>>();
  private readonly histograms = new Map<string, Map<string, HistogramSeries>>();
  private readonly dropped = new Map<string, number>();
  private readonly maxSeries: number;
  private readonly bounds: number[];

  constructor(options: MetricStoreOptions = {}) {
    this.maxSeries = options.maxSeriesPerMetric ?? 2000;
    // Copy + sort ascending: Prometheus rejects a histogram whose `le` series are
    // non-monotonic, so we never trust the caller's ordering, and the copy keeps
    // the exported default constant immutable.
    this.bounds = [...(options.durationBucketsMs ?? DEFAULT_DURATION_BUCKETS_MS)].sort((a, b) => a - b);
  }

  add(sample: MetricSample): void {
    // The counter and its companion duration-histogram are distinct metric names,
    // so each enforces the cap over its OWN series map. Under extreme cardinality
    // one may start dropping a beat before the other; both drops are attributed to
    // the right metric name, so the scrape stays internally consistent.
    const labelKey = serializeLabels(sample.labels);
    this.addCounter(sample.counter, labelKey, sample.labels);
    if (sample.durationMetric && sample.durationMs !== null) {
      this.addHistogram(sample.durationMetric, labelKey, sample.labels, sample.durationMs);
    }
  }

  private addCounter(metric: string, labelKey: string, labels: Record<string, string>): void {
    let series = this.counters.get(metric);
    if (series === undefined) {
      series = new Map();
      this.counters.set(metric, series);
    }
    let cell = series.get(labelKey);
    if (cell === undefined) {
      if (series.size >= this.maxSeries) {
        this.drop(metric);
        return;
      }
      cell = { labels, count: 0 };
      series.set(labelKey, cell);
    }
    cell.count += 1;
  }

  private addHistogram(
    metric: string,
    labelKey: string,
    labels: Record<string, string>,
    value: number,
  ): void {
    let series = this.histograms.get(metric);
    if (series === undefined) {
      series = new Map();
      this.histograms.set(metric, series);
    }
    let cell = series.get(labelKey);
    if (cell === undefined) {
      if (series.size >= this.maxSeries) {
        this.drop(metric);
        return;
      }
      cell = { labels, sum: 0, count: 0, buckets: new Array(this.bounds.length).fill(0) };
      series.set(labelKey, cell);
    }
    cell.sum += value;
    cell.count += 1;
    for (let i = 0; i < this.bounds.length; i++) {
      const bound = this.bounds[i];
      if (bound !== undefined && value <= bound) {
        cell.buckets[i] = (cell.buckets[i] ?? 0) + 1;
      }
    }
  }

  private drop(metric: string): void {
    this.dropped.set(metric, (this.dropped.get(metric) ?? 0) + 1);
  }

  prometheus(): string {
    const out: string[] = [];
    for (const [metric, series] of this.counters) {
      out.push(`# HELP ${metric} Telescope counter.`);
      out.push(`# TYPE ${metric} counter`);
      for (const cell of series.values()) {
        out.push(`${metric}${serializeLabels(cell.labels)} ${cell.count}`);
      }
    }
    for (const [metric, series] of this.histograms) {
      out.push(`# HELP ${metric} Telescope duration histogram (milliseconds).`);
      out.push(`# TYPE ${metric} histogram`);
      for (const cell of series.values()) {
        this.bounds.forEach((bound, i) => {
          out.push(`${metric}_bucket${labelsWith(cell.labels, 'le', String(bound))} ${cell.buckets[i] ?? 0}`);
        });
        out.push(`${metric}_bucket${labelsWith(cell.labels, 'le', '+Inf')} ${cell.count}`);
        out.push(`${metric}_sum${serializeLabels(cell.labels)} ${cell.sum}`);
        out.push(`${metric}_count${serializeLabels(cell.labels)} ${cell.count}`);
      }
    }
    if (this.dropped.size > 0) {
      const dm = 'telescope_metrics_dropped_series_total';
      // Counts dropped SAMPLES (not distinct series) — tracking distinct dropped
      // keys would itself be unbounded, defeating the cap. The rate of this
      // counter is the signal that a metric is over its cardinality budget.
      out.push(`# HELP ${dm} Samples dropped because their metric hit the per-metric cardinality cap.`);
      out.push(`# TYPE ${dm} counter`);
      for (const [metric, n] of this.dropped) {
        out.push(`${dm}{metric="${escapeLabelValue(metric)}"} ${n}`);
      }
    }
    return out.length ? `${out.join('\n')}\n` : '';
  }
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function serializeLabels(labels: Record<string, string>): string {
  const parts = Object.entries(labels)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
}

/** Serialize labels plus one extra label (e.g. `le`) — always emits braces. */
function labelsWith(labels: Record<string, string>, extraKey: string, extraVal: string): string {
  const parts = Object.entries(labels)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`);
  parts.push(`${extraKey}="${escapeLabelValue(extraVal)}"`);
  return `{${parts.join(',')}}`;
}
