// packages/core/src/agent-metrics/agent-metrics.ts
import type { AgentObservation, RunObservation, UsageObservation } from './agent-events.js';

/**
 * The AI-usage and agent-run metrics, as ONE table both exporters read: the dependency-free
 * Prometheus registry below and the OTLP exporter in `@dudousxd/nestjs-telescope-otel`. Names are
 * stable API — dashboards are built on them.
 *
 * Units live in the NAME (`_usd`, `_ms`, `_seconds`), and the OTLP instruments are created with an
 * EMPTY unit on purpose: Prometheus' OTLP translation appends a unit suffix (`ms` → `_milliseconds`),
 * which would make the same metric read `aviary_agent_run_duration_ms_milliseconds` through a
 * Collector and `aviary_agent_run_duration_ms` from the scrape. With no unit both paths expose the
 * same series, so one Grafana dashboard serves both.
 *
 * Cardinality: attributes are features, models, providers, agent and tool names only. `actorRef`,
 * `runId` and `threadId` NEVER become attributes — they grow with users and runs.
 */
export const AGENT_METRICS = {
  costUsd: {
    name: 'aviary_ai_cost_usd',
    type: 'counter',
    help: 'AI spend in US dollars, from usage.recorded rows that carried a cost.',
  },
  tokens: {
    name: 'aviary_ai_tokens',
    type: 'counter',
    help: 'AI tokens, by direction (in, out, cache_read, cache_write).',
  },
  audioSeconds: {
    name: 'aviary_ai_audio_seconds',
    type: 'counter',
    help: 'Seconds of audio processed by AI calls.',
  },
  requests: {
    name: 'aviary_ai_requests',
    type: 'counter',
    help: 'AI calls recorded in the usage ledger; cost_source="none" are the unpriced ones.',
  },
  runDurationMs: {
    name: 'aviary_agent_run_duration_ms',
    type: 'histogram',
    help: 'Agent run wall-clock duration in milliseconds, turn start to end.',
  },
  runQueueMs: {
    name: 'aviary_agent_run_queue_ms',
    type: 'histogram',
    help: 'Agent run time between enqueue and its body starting, in milliseconds.',
  },
  runModelMs: {
    name: 'aviary_agent_run_model_ms',
    type: 'histogram',
    help: 'Agent run time spent in model calls, in milliseconds.',
  },
  runToolsMs: {
    name: 'aviary_agent_run_tools_ms',
    type: 'histogram',
    help: 'Agent run time spent running tools (parallel calls once), in milliseconds.',
  },
  toolDurationMs: {
    name: 'aviary_agent_tool_duration_ms',
    type: 'histogram',
    help: 'One tool call duration, in milliseconds.',
  },
} as const;

export type AgentMetricKey = keyof typeof AGENT_METRICS;

/** Histogram upper bounds (ms), shared by the scrape and the OTLP instruments. */
export const AGENT_METRIC_BUCKETS_MS: readonly number[] = [
  10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 20000, 30000, 60000, 120000, 300000, 600000,
];

/** Attribute values are strings, except `platform`, which OTLP carries as a boolean. */
export type MetricAttributes = Record<string, string | boolean>;

/** One value an observation contributes to one metric. */
export interface MetricPoint {
  metric: AgentMetricKey;
  value: number;
  attributes: MetricAttributes;
}

function usagePoints(u: UsageObservation): MetricPoint[] {
  const common: MetricAttributes = {
    feature: u.feature,
    model: u.model,
    provider: u.provider,
    cost_source: u.costSource,
    platform: u.platform,
  };
  const points: MetricPoint[] = [{ metric: 'requests', value: u.requests, attributes: common }];
  if (u.costUsd !== undefined)
    points.push({ metric: 'costUsd', value: u.costUsd, attributes: common });
  if (u.audioSeconds > 0) {
    points.push({ metric: 'audioSeconds', value: u.audioSeconds, attributes: common });
  }
  const tokens: [string, number][] = [
    ['in', u.inputTokens],
    ['out', u.outputTokens],
    ['cache_read', u.cacheReadTokens],
    ['cache_write', u.cacheWriteTokens],
  ];
  for (const [direction, value] of tokens) {
    if (value > 0) {
      points.push({
        metric: 'tokens',
        value,
        attributes: { direction, feature: u.feature, model: u.model },
      });
    }
  }
  return points;
}

function runPoints(r: RunObservation): MetricPoint[] {
  const attributes: MetricAttributes = { agent: r.agent, status: r.status };
  const points: MetricPoint[] = [];
  const timed: [AgentMetricKey, number | undefined][] = [
    ['runDurationMs', r.durationMs],
    ['runQueueMs', r.queueMs],
    ['runModelMs', r.modelMs],
    ['runToolsMs', r.toolsMs],
  ];
  for (const [metric, value] of timed) {
    if (value !== undefined && value >= 0) points.push({ metric, value, attributes });
  }
  for (const step of r.stepTimings) {
    for (const tool of step.tools) {
      if (tool.ms >= 0) {
        points.push({
          metric: 'toolDurationMs',
          value: tool.ms,
          attributes: { tool: tool.toolName },
        });
      }
    }
  }
  return points;
}

/** Every metric point an observation contributes. Pure. */
export function agentMetricPoints(observation: AgentObservation): MetricPoint[] {
  return observation.kind === 'usage' ? usagePoints(observation) : runPoints(observation);
}

interface CounterSeries {
  labels: MetricAttributes;
  value: number;
}

interface HistogramSeries {
  labels: MetricAttributes;
  sum: number;
  count: number;
  buckets: number[];
}

export interface AgentMetricsRegistryOptions {
  /**
   * Max distinct label sets kept per metric. New combinations past it are dropped (existing ones
   * keep counting); every observation dropped that way is tallied in
   * `aviary_ai_metrics_dropped_series_total`. Default 2000.
   */
  maxSeriesPerMetric?: number;
}

/**
 * Dependency-free, in-process aggregation of {@link AGENT_METRICS} for the Prometheus scrape
 * (`GET <telescope path>/api/metrics`). Cumulative since process start, as Prometheus expects.
 */
export class AgentMetricsRegistry {
  private readonly counters = new Map<AgentMetricKey, Map<string, CounterSeries>>();
  private readonly histograms = new Map<AgentMetricKey, Map<string, HistogramSeries>>();
  private readonly dropped = new Map<string, number>();
  private readonly maxSeries: number;

  constructor(options: AgentMetricsRegistryOptions = {}) {
    this.maxSeries = options.maxSeriesPerMetric ?? 2000;
  }

  observe(observation: AgentObservation): void {
    for (const point of agentMetricPoints(observation)) this.add(point);
  }

  add(point: MetricPoint): void {
    const def = AGENT_METRICS[point.metric];
    const key = labelKey(point.attributes);
    if (def.type === 'counter') {
      const series = getOrCreate(this.counters, point.metric);
      let cell = series.get(key);
      if (cell === undefined) {
        if (series.size >= this.maxSeries) {
          this.drop(def.name);
          return;
        }
        cell = { labels: point.attributes, value: 0 };
        series.set(key, cell);
      }
      cell.value += point.value;
      return;
    }
    const series = getOrCreate(this.histograms, point.metric);
    let cell = series.get(key);
    if (cell === undefined) {
      if (series.size >= this.maxSeries) {
        this.drop(def.name);
        return;
      }
      cell = {
        labels: point.attributes,
        sum: 0,
        count: 0,
        buckets: new Array<number>(AGENT_METRIC_BUCKETS_MS.length).fill(0),
      };
      series.set(key, cell);
    }
    cell.sum += point.value;
    cell.count += 1;
    AGENT_METRIC_BUCKETS_MS.forEach((bound, i) => {
      if (point.value <= bound) cell.buckets[i] = (cell.buckets[i] ?? 0) + 1;
    });
  }

  private drop(metric: string): void {
    this.dropped.set(metric, (this.dropped.get(metric) ?? 0) + 1);
  }

  /**
   * Prometheus text exposition (format 0.0.4). Counters are exposed with the `_total` suffix —
   * the same name Prometheus gives an OTLP monotonic sum — so the shipped dashboard reads either.
   */
  prometheus(): string {
    const lines: string[] = [];
    for (const key of Object.keys(AGENT_METRICS) as AgentMetricKey[]) {
      const def = AGENT_METRICS[key];
      if (def.type === 'counter') {
        const series = this.counters.get(key);
        if (series === undefined || series.size === 0) continue;
        const name = `${def.name}_total`;
        lines.push(`# HELP ${name} ${def.help}`, `# TYPE ${name} counter`);
        for (const cell of series.values()) {
          lines.push(`${name}${formatLabels(cell.labels)} ${formatNumber(cell.value)}`);
        }
        continue;
      }
      const series = this.histograms.get(key);
      if (series === undefined || series.size === 0) continue;
      lines.push(`# HELP ${def.name} ${def.help}`, `# TYPE ${def.name} histogram`);
      for (const cell of series.values()) {
        AGENT_METRIC_BUCKETS_MS.forEach((bound, i) => {
          lines.push(
            `${def.name}_bucket${formatLabels({ ...cell.labels, le: String(bound) })} ${cell.buckets[i] ?? 0}`,
          );
        });
        lines.push(
          `${def.name}_bucket${formatLabels({ ...cell.labels, le: '+Inf' })} ${cell.count}`,
        );
        lines.push(`${def.name}_sum${formatLabels(cell.labels)} ${formatNumber(cell.sum)}`);
        lines.push(`${def.name}_count${formatLabels(cell.labels)} ${cell.count}`);
      }
    }
    if (this.dropped.size > 0) {
      const name = 'aviary_ai_metrics_dropped_series_total';
      lines.push(
        `# HELP ${name} Observations dropped because their label set was new and the metric was at its series cap.`,
        `# TYPE ${name} counter`,
      );
      for (const [metric, count] of this.dropped) {
        lines.push(`${name}${formatLabels({ metric })} ${count}`);
      }
    }
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  }
}

function getOrCreate<K, V>(map: Map<K, Map<string, V>>, key: K): Map<string, V> {
  let inner = map.get(key);
  if (inner === undefined) {
    inner = new Map();
    map.set(key, inner);
  }
  return inner;
}

function labelKey(labels: MetricAttributes): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${String(labels[k])}`)
    .join('\u0000');
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function formatLabels(labels: MetricAttributes): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return '';
  return `{${keys.map((k) => `${k}="${escapeLabel(String(labels[k]))}"`).join(',')}}`;
}

function formatNumber(value: number): string {
  // Avoid float noise like 0.30000000000000004 in the exposition.
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12)));
}
