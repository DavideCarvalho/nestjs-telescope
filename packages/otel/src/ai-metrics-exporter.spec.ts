// packages/otel/src/ai-metrics-exporter.spec.ts
import diagnostics_channel from 'node:diagnostics_channel';
import { metrics } from '@opentelemetry/api';
import {
  type DataPoint,
  MeterProvider,
  MetricReader,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { afterEach, describe, expect, it } from 'vitest';
import { TelescopeAiMetricsExporter } from './ai-metrics-exporter.js';

/** A reader the test pulls from, like the SDK's periodic reader does on its interval. */
class InMemoryReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

function globalMeterProvider(): InMemoryReader {
  const reader = new InMemoryReader();
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
  return reader;
}

async function collected(reader: InMemoryReader) {
  const { resourceMetrics } = (await reader.collect()) as { resourceMetrics: ResourceMetrics };
  return resourceMetrics.scopeMetrics.flatMap((scope) =>
    scope.metrics.map((metric) => ({
      scope: scope.scope.name,
      name: metric.descriptor.name,
      unit: metric.descriptor.unit,
      points: metric.dataPoints as DataPoint<unknown>[],
    })),
  );
}

const usage = {
  actorRef: '@platform',
  feature: 'summaries',
  modelId: 'claude-haiku',
  provider: 'anthropic',
  inputTokens: 500,
  outputTokens: 80,
  costUsd: 0.002,
  costSource: 'estimate',
  runId: 'run-9',
};

describe('TelescopeAiMetricsExporter', () => {
  afterEach(() => {
    metrics.disable();
  });

  it('records agent events on the global MeterProvider, without high-cardinality attributes', async () => {
    const reader = globalMeterProvider();
    const exporter = new TelescopeAiMetricsExporter();
    for (const w of exporter.watchers()) await w.register({} as never);

    diagnostics_channel.channel('aviary:agent:usage.recorded').publish({ payload: usage });
    diagnostics_channel.channel('aviary:agent:run.finished').publish({
      payload: {
        runId: 'run-9',
        actorId: 'u',
        agentName: 'tutor',
        durationMs: 900,
        stepTimings: [
          { step: 0, toolsMs: 5, tools: [{ toolCallId: 'x', toolName: 'search', ms: 5 }] },
        ],
      },
    });

    const all = await collected(reader);
    expect(new Set(all.map((m) => m.scope))).toEqual(new Set(['telescope']));
    for (const m of all) expect(m.unit).toBe('');

    const cost = all.find((m) => m.name === 'aviary_ai_cost_usd');
    expect(cost?.points.map((p) => [p.value, p.attributes])).toEqual([
      [
        0.002,
        {
          feature: 'summaries',
          model: 'claude-haiku',
          provider: 'anthropic',
          cost_source: 'estimate',
          platform: true,
        },
      ],
    ]);
    const duration = all.find((m) => m.name === 'aviary_agent_run_duration_ms');
    const point = duration?.points[0] as DataPoint<{
      sum: number;
      buckets: { boundaries: number[] };
    }>;
    expect(point.attributes).toEqual({ agent: 'tutor', status: 'completed' });
    expect(point.value.sum).toBe(900);
    expect(point.value.buckets.boundaries).toContain(600000);
    const tool = all.find((m) => m.name === 'aviary_agent_tool_duration_ms');
    expect(tool?.points[0]?.attributes).toEqual({ tool: 'search' });

    const serialized = JSON.stringify(all.map((m) => m.points.map((p) => p.attributes)));
    expect(serialized).not.toContain('run-9');
    expect(serialized).not.toContain('@platform');

    for (const w of exporter.watchers()) await w.unregister?.();
    expect(diagnostics_channel.channel('aviary:agent:usage.recorded').hasSubscribers).toBe(false);
  });

  it('uses an explicit meter when given one', async () => {
    const reader = new InMemoryReader();
    const provider = new MeterProvider({ readers: [reader] });
    const exporter = new TelescopeAiMetricsExporter({ meter: provider.getMeter('mine') });
    exporter.start();
    diagnostics_channel.channel('aviary:agent:usage.recorded').publish({ payload: usage });
    const all = await collected(reader);
    expect(all.find((m) => m.name === 'aviary_ai_requests')?.scope).toBe('mine');
    exporter.shutdown();
  });

  it('is a no-op without an OpenTelemetry SDK', () => {
    const exporter = new TelescopeAiMetricsExporter();
    exporter.start();
    expect(() =>
      diagnostics_channel.channel('aviary:agent:usage.recorded').publish({ payload: usage }),
    ).not.toThrow();
    exporter.shutdown();
  });

  it.each(['endpoint', 'exportIntervalMs', 'serviceName', 'headers', 'path', 'timeoutMs'])(
    'throws at boot when given the removed `%s` option',
    (key) => {
      expect(() => new TelescopeAiMetricsExporter({ [key]: 'x' } as never)).toThrow(
        /no longer exports metrics itself.*NodeSDK/s,
      );
    },
  );
});
