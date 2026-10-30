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
import type { Counter, Histogram } from '@opentelemetry/api';

export interface TelescopeAiMetricsExporterOptions {
  /**
   * Base URL of the OTLP/HTTP receiver for METRICS — a Collector, or Grafana's `grafana/otel-lgtm`.
   * Independent of wherever your traces and logs go, so metrics can land in a local Grafana while
   * traces keep flowing elsewhere. Default `process.env.OTEL_EXPORTER_OTLP_ENDPOINT`,
   * else `'http://localhost:4318'`.
   */
  endpoint?: string;
  /** Path appended to `endpoint`. Default `'/v1/metrics'`. */
  path?: string;
  /** Extra headers on every export (e.g. an auth token for a hosted Collector). */
  headers?: Record<string, string>;
  /** How often the reader pushes, in ms. Default `60000`. */
  exportIntervalMs?: number;
  /** Per-export HTTP timeout, in ms. Default `10000`. */
  timeoutMs?: number;
  /** `service.name` resource attribute. Default `process.env.OTEL_SERVICE_NAME`, else `'nestjs-app'`. */
  serviceName?: string;
}

/** The pieces of the OTel metrics SDK this exporter needs — injectable for tests. */
export interface OtelMetricsSdk {
  createMeterProvider(options: {
    url: string;
    headers: Record<string, string>;
    exportIntervalMs: number;
    timeoutMs: number;
    serviceName: string;
  }): {
    getMeter(name: string): {
      createCounter(name: string, options?: { description?: string; unit?: string }): Counter;
      createHistogram(
        name: string,
        options?: {
          description?: string;
          unit?: string;
          advice?: { explicitBucketBoundaries?: number[] };
        },
      ): Histogram;
    };
    forceFlush(): Promise<void>;
    shutdown(): Promise<void>;
  };
}

/**
 * Loads `@opentelemetry/sdk-metrics`, `@opentelemetry/exporter-metrics-otlp-http` and
 * `@opentelemetry/resources` lazily — they are optional peers, so a host that never constructs
 * this exporter never needs them installed.
 */
async function loadSdk(): Promise<OtelMetricsSdk> {
  const [metricsSdk, exporterPkg, resources] = await Promise.all([
    import('@opentelemetry/sdk-metrics'),
    import('@opentelemetry/exporter-metrics-otlp-http'),
    import('@opentelemetry/resources'),
  ]);
  return {
    createMeterProvider(options) {
      const exporter = new exporterPkg.OTLPMetricExporter({
        url: options.url,
        headers: options.headers,
        timeoutMillis: options.timeoutMs,
      });
      const reader = new metricsSdk.PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: options.exportIntervalMs,
        exportTimeoutMillis: Math.min(options.timeoutMs, options.exportIntervalMs),
      });
      return new metricsSdk.MeterProvider({
        resource: resources.resourceFromAttributes({ 'service.name': options.serviceName }),
        readers: [reader],
      });
    },
  };
}

type Provider = ReturnType<OtelMetricsSdk['createMeterProvider']>;

/**
 * Pushes the AI-usage and agent-run metrics (`aviary_ai_*`, `aviary_agent_*`, see
 * `AGENT_METRICS` in `@dudousxd/nestjs-telescope`) over OTLP/HTTP from a PRIVATE `MeterProvider`
 * — it never registers a global provider, so it cannot clash with the host's own OTel SDK.
 *
 * Fed straight from the `aviary:agent:*` diagnostics channels, not from recorded entries, so
 * sampling and retention never change a count.
 *
 * ```ts
 * const aiMetrics = new TelescopeAiMetricsExporter({ endpoint: 'http://localhost:4318' });
 * TelescopeModule.forRoot({ extensions: [aiMetrics] });
 * ```
 *
 * Instruments are created with an empty unit (the unit is in the name), so Prometheus' OTLP
 * translation keeps the exact names the Prometheus scrape uses.
 */
export class TelescopeAiMetricsExporter implements TelescopeExtension {
  readonly name = 'otel-ai-metrics';
  private provider: Provider | null = null;
  private unsubscribe: (() => void) | null = null;
  private starting: Promise<void> | null = null;
  private readonly instruments = new Map<AgentMetricKey, Counter | Histogram>();

  constructor(
    private readonly options: TelescopeAiMetricsExporterOptions = {},
    private readonly sdkLoader: () => Promise<OtelMetricsSdk> = loadSdk,
  ) {}

  /** Starts on Telescope's watcher registration, so it follows the module's lifecycle. */
  watchers(): Watcher[] {
    return [{ type: 'otel-ai-metrics', register: () => this.start() }];
  }

  /** Build the meter provider and subscribe. Idempotent. Never throws: a missing peer is logged. */
  start(): Promise<void> {
    if (this.starting !== null) return this.starting;
    this.starting = this.doStart();
    return this.starting;
  }

  private async doStart(): Promise<void> {
    let sdk: OtelMetricsSdk;
    try {
      sdk = await this.sdkLoader();
    } catch (err) {
      console.error(
        '@dudousxd/nestjs-telescope-otel: TelescopeAiMetricsExporter needs @opentelemetry/sdk-metrics, ' +
          '@opentelemetry/exporter-metrics-otlp-http and @opentelemetry/resources installed. ' +
          'AI metrics export is off.',
        err,
      );
      return;
    }
    const base = (
      this.options.endpoint ??
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
      'http://localhost:4318'
    ).replace(/\/+$/, '');
    const provider = sdk.createMeterProvider({
      url: `${base}${this.options.path ?? '/v1/metrics'}`,
      headers: this.options.headers ?? {},
      exportIntervalMs: this.options.exportIntervalMs ?? 60_000,
      timeoutMs: this.options.timeoutMs ?? 10_000,
      serviceName: this.options.serviceName ?? process.env.OTEL_SERVICE_NAME ?? 'nestjs-app',
    });
    const meter = provider.getMeter('@dudousxd/nestjs-telescope-otel');
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
    this.provider = provider;
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

  /** Push whatever is pending now. */
  async flush(): Promise<void> {
    await this.provider?.forceFlush();
  }

  /** Unsubscribe, flush and shut the meter provider down (call from your app's shutdown). */
  async shutdown(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.starting;
    await this.provider?.shutdown().catch(() => undefined);
    this.provider = null;
    this.starting = null;
    this.instruments.clear();
  }
}
