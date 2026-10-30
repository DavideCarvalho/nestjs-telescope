// packages/otel/src/ai-metrics-exporter.spec.ts
import diagnostics_channel from 'node:diagnostics_channel';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { type OtelMetricsSdk, TelescopeAiMetricsExporter } from './ai-metrics-exporter.js';

interface Created {
  kind: 'counter' | 'histogram';
  name: string;
  options: Record<string, unknown> | undefined;
  calls: [number, Record<string, unknown>][];
}

function fakeSdk() {
  const created: Created[] = [];
  const providerOptions: unknown[] = [];
  let shutdowns = 0;
  const sdk: OtelMetricsSdk = {
    createMeterProvider(options) {
      providerOptions.push(options);
      const make = (kind: Created['kind']) => (name: string, opts?: Record<string, unknown>) => {
        const c: Created = { kind, name, options: opts, calls: [] };
        created.push(c);
        const fn = (value: number, attrs?: Record<string, unknown>) => {
          c.calls.push([value, attrs ?? {}]);
        };
        return { add: fn, record: fn } as never;
      };
      return {
        getMeter: () => ({ createCounter: make('counter'), createHistogram: make('histogram') }),
        forceFlush: async () => undefined,
        shutdown: async () => {
          shutdowns += 1;
        },
      };
    },
  };
  return { sdk, created, providerOptions, shutdowns: () => shutdowns };
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
  it('creates every instrument with an empty unit and the shared buckets', async () => {
    const fake = fakeSdk();
    const exporter = new TelescopeAiMetricsExporter(
      { endpoint: 'http://collector:4318/', serviceName: 'svc' },
      async () => fake.sdk,
    );
    await exporter.start();
    expect(fake.providerOptions[0]).toMatchObject({
      url: 'http://collector:4318/v1/metrics',
      serviceName: 'svc',
    });
    expect(fake.created.map((c) => c.name)).toEqual([
      'aviary_ai_cost_usd',
      'aviary_ai_tokens',
      'aviary_ai_audio_seconds',
      'aviary_ai_requests',
      'aviary_agent_run_duration_ms',
      'aviary_agent_run_queue_ms',
      'aviary_agent_run_model_ms',
      'aviary_agent_run_tools_ms',
      'aviary_agent_tool_duration_ms',
    ]);
    for (const c of fake.created) expect(c.options?.unit).toBe('');
    const hist = fake.created.find((c) => c.name === 'aviary_agent_run_duration_ms');
    expect(
      (hist?.options?.advice as { explicitBucketBoundaries: number[] }).explicitBucketBoundaries,
    ).toContain(600000);
    await exporter.shutdown();
  });

  it('records published agent events without high-cardinality attributes', async () => {
    const fake = fakeSdk();
    const exporter = new TelescopeAiMetricsExporter({}, async () => fake.sdk);
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
    const cost = fake.created.find((c) => c.name === 'aviary_ai_cost_usd');
    expect(cost?.calls).toEqual([
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
    expect(fake.created.find((c) => c.name === 'aviary_agent_run_duration_ms')?.calls).toEqual([
      [900, { agent: 'tutor', status: 'completed' }],
    ]);
    expect(fake.created.find((c) => c.name === 'aviary_agent_tool_duration_ms')?.calls).toEqual([
      [5, { tool: 'search' }],
    ]);
    const all = JSON.stringify(fake.created.map((c) => c.calls));
    expect(all).not.toContain('run-9');
    expect(all).not.toContain('@platform');
    await exporter.shutdown();
    expect(fake.shutdowns()).toBe(1);
    expect(diagnostics_channel.channel('aviary:agent:usage.recorded').hasSubscribers).toBe(false);
  });

  it('logs and stays off when the SDK is missing', async () => {
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args[0]);
    try {
      const exporter = new TelescopeAiMetricsExporter({}, async () => {
        throw new Error('Cannot find module');
      });
      await expect(exporter.start()).resolves.toBeUndefined();
      expect(String(errors[0])).toContain('@opentelemetry/sdk-metrics');
      expect(diagnostics_channel.channel('aviary:agent:usage.recorded').hasSubscribers).toBe(false);
    } finally {
      console.error = original;
    }
  });

  it('pushes OTLP/HTTP with the real SDK', async () => {
    const bodies: Buffer[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        bodies.push(Buffer.concat(chunks));
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const exporter = new TelescopeAiMetricsExporter({
        endpoint: `http://127.0.0.1:${port}`,
        exportIntervalMs: 60_000,
      });
      await exporter.start();
      diagnostics_channel.channel('aviary:agent:usage.recorded').publish({ payload: usage });
      await exporter.flush();
      await exporter.shutdown();
      expect(bodies.length).toBeGreaterThan(0);
      expect(Buffer.concat(bodies).toString('latin1')).toContain('aviary_ai_cost_usd');
    } finally {
      server.close();
    }
  });
});
