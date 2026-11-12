// packages/otel/src/ai-metrics-exporter.ts
import {
  AGENT_METRICS,
  AGENT_METRIC_BUCKETS_MS,
  type AgentMetricKey,
  type AgentObservation,
  type TelescopeExtension,
  type Watcher,
  agentMetricPoints,
  subscribeAgentObservations,
} from '@dudousxd/nestjs-telescope';
import { type Counter, type Histogram, type Meter, metrics } from '@opentelemetry/api';

export interface TelescopeAiMetricsExporterOptions {
  /**
   * Meter the instruments are created on. Default `metrics.getMeter('telescope')`, read when
   * Telescope starts, so the global `MeterProvider` your OpenTelemetry SDK registers is used.
   */
  meter?: Meter;
}

/** Options of the private OTLP exporter this class used to run. Exporting is the SDK's job now. */
const REMOVED_OPTIONS = [
  'endpoint',
  'path',
  'headers',
  'exportIntervalMs',
  'timeoutMs',
  'serviceName',
] as const;

/**
 * Records the AI-usage and agent-run metrics (`aviary_ai_*`, `aviary_agent_*`, see
 * `AGENT_METRICS` in `@dudousxd/nestjs-telescope`) on the global OpenTelemetry meter. Your
 * OpenTelemetry SDK (`NodeSDK` with a metric reader) decides where they go.
 *
 * Fed straight from the `aviary:agent:*` diagnostics channels, not from recorded entries, so
 * sampling and retention never change a count.
 *
 * ```ts
 * TelescopeModule.forRoot({ extensions: [new TelescopeAiMetricsExporter()] });
 * ```
 *
 * Instruments are created with an empty unit (the unit is in the name), so Prometheus' OTLP
 * translation keeps the exact names the Prometheus scrape uses.
 */
export class TelescopeAiMetricsExporter implements TelescopeExtension {
  readonly name = 'otel-ai-metrics';
  private unsubscribe: (() => void) | null = null;
  private readonly instruments = new Map<AgentMetricKey, Counter | Histogram>();

  constructor(private readonly options: TelescopeAiMetricsExporterOptions = {}) {
    const removed = REMOVED_OPTIONS.filter((key) => key in (options as Record<string, unknown>));
    if (removed.length > 0) {
      const keys = removed.map((key) => `\`${key}\``).join(', ');
      const verb = removed.length === 1 ? 'is' : 'are';
      throw new Error(
        [
          `@dudousxd/nestjs-telescope-otel: TelescopeAiMetricsExporter no longer exports metrics itself, so ${keys} ${verb} not supported.`,
          'Configure the endpoint, headers, interval and service name on your OpenTelemetry SDK',
          '(`new NodeSDK({ serviceName, metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url, headers }), exportIntervalMillis })] })`)',
          'and the AI metrics go out with the rest of your metrics.',
        ].join(' '),
      );
    }
  }

  /** Starts on Telescope's watcher registration, so it follows the module's lifecycle. */
  watchers(): Watcher[] {
    return [
      {
        type: 'otel-ai-metrics',
        register: () => this.start(),
        unregister: () => this.shutdown(),
      },
    ];
  }

  /** Create the instruments and subscribe. Idempotent. */
  start(): void {
    if (this.unsubscribe !== null) return;
    const meter = this.options.meter ?? metrics.getMeter('telescope');
    for (const key of Object.keys(AGENT_METRICS) as AgentMetricKey[]) {
      const def = AGENT_METRICS[key];
      this.instruments.set(
        key,
        def.type === 'counter'
          ? meter.createCounter(def.name, { description: def.help, unit: '' })
          : meter.createHistogram(def.name, {
              description: def.help,
              unit: '',
              advice: { explicitBucketBoundaries: [...AGENT_METRIC_BUCKETS_MS] },
            }),
      );
    }
    this.unsubscribe = subscribeAgentObservations((o) => this.observe(o));
  }

  /** Record one observation. Exposed for tests and for apps that read the events themselves. */
  observe(observation: AgentObservation): void {
    for (const point of agentMetricPoints(observation)) {
      const instrument = this.instruments.get(point.metric);
      if (instrument === undefined) continue;
      if (AGENT_METRICS[point.metric].type === 'counter') {
        (instrument as Counter).add(point.value, point.attributes);
      } else {
        (instrument as Histogram).record(point.value, point.attributes);
      }
    }
  }

  /** Unsubscribe from the agent events. The SDK flushes and shuts its providers down. */
  shutdown(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.instruments.clear();
  }
}
