import type { Entry } from '@dudousxd/nestjs-telescope';
import { type Meter, trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_DURATION_BUCKETS_MS } from './instrument-map.js';
import { TelescopeOtelExporter } from './telescope-otel-exporter.js';

describe('TelescopeOtelExporter.observeRecord', () => {
  it('is a TelescopeExtension named otel-export', () => {
    const exporter = new TelescopeOtelExporter();
    expect(exporter.name).toBe('otel-export');
    expect(typeof exporter.observeRecord).toBe('function');
  });

  it('aggregates records into the Prometheus exposition', () => {
    const exporter = new TelescopeOtelExporter();
    exporter.observeRecord({
      type: 'request',
      content: { method: 'GET', statusCode: 200 },
      durationMs: 5,
    });
    exporter.observeRecord({
      type: 'request',
      content: { method: 'GET', statusCode: 200 },
      durationMs: 7,
    });
    const text = exporter.prometheus();
    expect(text).toContain('telescope_requests_total{method="GET",status="200"} 2');
  });

  it('ignores unmapped types', () => {
    const exporter = new TelescopeOtelExporter();
    exporter.observeRecord({ type: 'dump', content: {} });
    expect(exporter.prometheus()).toBe('');
  });
});

describe('TelescopeOtelExporter OTLP meter path', () => {
  it('writes to the injected OTel meter (counter.add + histogram.record)', () => {
    const counterAdds: Array<[number, Record<string, string>]> = [];
    const histRecords: Array<[number, Record<string, string>]> = [];
    const created = { counters: [] as string[], histograms: [] as string[] };
    const histogramOptions: Array<{ advice?: { explicitBucketBoundaries?: number[] } }> = [];
    const meter = {
      createCounter: (name: string) => {
        created.counters.push(name);
        return { add: (v: number, a: Record<string, string>) => counterAdds.push([v, a]) };
      },
      createHistogram: (
        name: string,
        options: { advice?: { explicitBucketBoundaries?: number[] } },
      ) => {
        created.histograms.push(name);
        histogramOptions.push(options);
        return { record: (v: number, a: Record<string, string>) => histRecords.push([v, a]) };
      },
    } as unknown as Meter;

    const exporter = new TelescopeOtelExporter({ meter });
    exporter.observeRecord({
      type: 'request',
      content: { method: 'GET', statusCode: 200 },
      durationMs: 12,
    });

    expect(created.counters).toContain('telescope_requests_total');
    expect(created.histograms).toContain('telescope_request_duration_ms');
    expect(counterAdds).toEqual([[1, { method: 'GET', status: '200' }]]);
    expect(histRecords).toEqual([[12, { method: 'GET', status: '200' }]]);
    // OTLP histogram boundaries align with the Prometheus scrape buckets.
    expect(histogramOptions[0]?.advice?.explicitBucketBoundaries).toEqual(
      DEFAULT_DURATION_BUCKETS_MS,
    );
  });
});

describe('TelescopeOtelExporter.observeFlush', () => {
  afterEach(() => {
    trace.disable();
  });

  it('emits one span per entry through the OTel tracer', () => {
    const memory = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memory)] });
    trace.setGlobalTracerProvider(provider);

    const exporter = new TelescopeOtelExporter();
    exporter.observeFlush([
      {
        id: 'e1',
        batchId: 'b',
        type: 'request',
        familyHash: null,
        content: {},
        tags: [],
        sequence: 0,
        durationMs: 12,
        origin: 'http',
        instanceId: 'p',
        traceId: null,
        spanId: null,
        createdAt: new Date(1_000),
      } as Entry,
    ]);

    const spans = memory.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('telescope.request');
    expect(spans[0].attributes['telescope.type']).toBe('request');
  });
});
