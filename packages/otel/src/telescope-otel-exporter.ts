import { type Counter, type Histogram, type Meter, metrics } from '@opentelemetry/api';
import type { RecordInput, TelescopeExtension } from '@dudousxd/nestjs-telescope';
import { mapInput, MetricStore } from './instrument-map.js';

export interface TelescopeOtelExporterOptions {
  /** OTel Meter for OTLP push. Defaults to the global meter (no-op without an SDK). */
  meter?: Meter;
}

/**
 * Exports everything Telescope records as complete metrics (and, in Task 6,
 * sampled spans). Implements TelescopeExtension: pass it to
 * `TelescopeModule.forRoot({ extensions: [exporter] })`.
 */
export class TelescopeOtelExporter implements TelescopeExtension {
  readonly name = 'otel-export';
  private readonly store = new MetricStore();
  private readonly meter: Meter;
  private readonly counters = new Map<string, Counter>();
  private readonly histograms = new Map<string, Histogram>();

  constructor(private readonly options: TelescopeOtelExporterOptions = {}) {
    this.meter = options.meter ?? metrics.getMeter('telescope');
  }

  observeRecord(input: RecordInput): void {
    const sample = mapInput(input);
    if (sample === null) return;
    // Dependency-free aggregation for the Prometheus scrape.
    this.store.add(sample);
    // Mirror into the OTel Meter for OTLP push (no-op without an SDK).
    this.counter(sample.counter).add(1, sample.labels);
    if (sample.durationMetric && sample.durationMs !== null) {
      this.histogram(sample.durationMetric).record(sample.durationMs, sample.labels);
    }
  }

  /** Prometheus text exposition for a `/metrics` scrape. */
  prometheus(): string {
    return this.store.prometheus();
  }

  private counter(name: string): Counter {
    let c = this.counters.get(name);
    if (c === undefined) {
      c = this.meter.createCounter(name);
      this.counters.set(name, c);
    }
    return c;
  }

  private histogram(name: string): Histogram {
    let h = this.histograms.get(name);
    if (h === undefined) {
      h = this.meter.createHistogram(name, { unit: 'ms' });
      this.histograms.set(name, h);
    }
    return h;
  }
}
