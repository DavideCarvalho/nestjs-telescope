// packages/core/src/agent-metrics/ai-usage.spec.ts
import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { summarizeAiUsage } from './ai-usage.js';
import { AiUsageService } from './ai-usage.service.js';

const end = new Date('2026-10-29T12:00:00Z');
const start = new Date(end.getTime() - 3_600_000);
let seq = 0;

function entry(
  type: string,
  content: unknown,
  minutesAgo: number,
  traceId: string | null = null,
): Entry {
  seq += 1;
  return {
    id: `e${seq}`,
    batchId: 'b',
    type,
    familyHash: null,
    content,
    tags: [],
    sequence: seq,
    durationMs: null,
    origin: 'http',
    instanceId: 'i',
    traceId,
    spanId: null,
    createdAt: new Date(end.getTime() - minutesAgo * 60_000),
  };
}

const agentUsage = (minutesAgo: number, over: Record<string, unknown>) =>
  entry(
    'agent',
    {
      event: 'usage.recorded',
      actorRef: 'user:1',
      feature: 'agent:tutor',
      purpose: 'chat',
      modelId: 'gpt-5',
      provider: 'openai',
      inputTokens: 100,
      outputTokens: 50,
      ...over,
    },
    minutesAgo,
  );

describe('summarizeAiUsage', () => {
  const entries: Entry[] = [
    agentUsage(5, { costUsd: 0.5, costSource: 'provider' }),
    agentUsage(10, {
      costUsd: 0.25,
      costSource: 'estimate',
      actorRef: '@platform',
      feature: 'summaries',
      modelId: 'claude-haiku',
    }),
    agentUsage(20, {
      feature: 'transcribe',
      modelId: 'whisper-1',
      provider: 'openai',
      audioSeconds: 30,
      requests: 2,
    }),
    entry(
      'agent',
      {
        event: 'usage.recorded',
        actorRef: 'user:2',
        feature: 'agent:tutor',
        modelId: 'gpt-5',
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.1,
      },
      30,
    ),
    entry(
      'agent',
      {
        event: 'run.finished',
        runId: 'r1',
        agentName: 'tutor',
        durationMs: 9000,
        queueMs: 100,
        modelMs: 6000,
        toolsMs: 2500,
        steps: 2,
        costUsd: 0.6,
        modelId: 'gpt-5',
        stepTimings: [
          {
            step: 0,
            modelMs: 4000,
            toolsMs: 2500,
            tools: [{ toolCallId: 'x', toolName: 'search', ms: 2500 }],
          },
        ],
      },
      6,
      'trace-1',
    ),
    entry(
      'agent',
      {
        event: 'run.failed',
        runId: 'r2',
        code: 'run_failed',
        message: 'nope',
        durationMs: 300,
        context: { actorId: 'u', agentName: 'billing' },
      },
      8,
    ),
    entry('agent', { event: 'run.finished', runId: 'r3', durationMs: 1200 }, 9),
    // Outside the window, and not an agent event.
    agentUsage(120, { costUsd: 99 }),
    entry('request', { url: '/x' }, 1),
  ];
  const summary = summarizeAiUsage(entries, {
    windowStart: start,
    windowEnd: end,
    buckets: 6,
    top: 5,
  });

  it('totals spend with the platform and estimated shares', () => {
    expect(summary.spend.totalUsd).toBeCloseTo(0.85);
    expect(summary.spend.platformUsd).toBeCloseTo(0.25);
    expect(summary.spend.estimatedUsd).toBeCloseTo(0.25);
    expect(summary.spend.calls).toBe(5);
    expect(summary.spend.unpricedCalls).toBe(2);
    expect(summary.spend.audioSeconds).toBe(30);
  });

  it('breaks spend down by feature, model and actor', () => {
    expect(summary.spend.byFeature[0]).toMatchObject({ key: 'agent:tutor', calls: 2 });
    expect(summary.spend.byFeature[0]?.costUsd).toBeCloseTo(0.6);
    expect(summary.spend.byModel.map((r) => r.key)).toEqual(['gpt-5', 'claude-haiku', 'whisper-1']);
    expect(summary.spend.byActor.map((r) => r.key)).toContain('@platform');
  });

  it('buckets spend over the window', () => {
    expect(summary.spend.buckets).toHaveLength(6);
    expect(summary.spend.buckets.reduce((n, b) => n + b.costUsd, 0)).toBeCloseTo(0.85);
  });

  it('lists runs newest first, with slowest and most expensive', () => {
    expect(summary.runs.map((r) => r.runId)).toEqual(['r1', 'r2', 'r3']);
    expect(summary.runs[0]).toMatchObject({
      traceId: 'trace-1',
      status: 'completed',
      queueMs: 100,
      stepTimings: [{ step: 0 }],
    });
    expect(summary.runs[1]).toMatchObject({
      status: 'failed',
      agent: 'billing',
      code: 'run_failed',
    });
    expect(summary.slowest[0]?.runId).toBe('r1');
    expect(summary.mostExpensive.map((r) => r.runId)).toEqual(['r1']);
  });

  it('groups unpriced calls', () => {
    expect(summary.unpriced).toEqual([
      expect.objectContaining({
        feature: 'transcribe',
        model: 'whisper-1',
        provider: 'openai',
        calls: 2,
        audioSeconds: 30,
      }),
    ]);
  });

  it('reports coverage, including runs without timings', () => {
    expect(summary.coverage).toMatchObject({
      usageEvents: 4,
      runEvents: 3,
      legacyAgentLib: false,
      runsWithoutTimings: 2,
    });
  });

  it('reads the diagnostics bridge shape, and counts an event once when both watchers stored it', () => {
    const payload = {
      actorRef: 'u',
      feature: 'f',
      modelId: 'm',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.2,
    };
    const bridgeOnly = summarizeAiUsage(
      [entry('diagnostic', { lib: 'agent', event: 'usage.recorded', payload }, 1)],
      {
        windowStart: start,
        windowEnd: end,
      },
    );
    expect(bridgeOnly.spend.totalUsd).toBe(0.2);
    const both = summarizeAiUsage(
      [
        entry('agent', { event: 'usage.recorded', ...payload }, 1),
        entry('diagnostic', { lib: 'agent', event: 'usage.recorded', payload }, 1),
      ],
      { windowStart: start, windowEnd: end },
    );
    expect(both.spend.totalUsd).toBe(0.2);
    expect(both.coverage.usageEvents).toBe(1);
  });

  it('flags an agent lib that predates usage.recorded', () => {
    const legacy = summarizeAiUsage(
      [
        entry('agent', { event: 'run.started', runId: 'r' }, 1),
        entry('agent', { event: 'run.finished', runId: 'r', steps: 1 }, 1),
      ],
      { windowStart: start, windowEnd: end },
    );
    expect(legacy.coverage.legacyAgentLib).toBe(true);
    expect(
      summarizeAiUsage([], { windowStart: start, windowEnd: end }).coverage.legacyAgentLib,
    ).toBe(false);
  });
});

describe('AiUsageService', () => {
  it('reads agent entries from storage', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    await storage.store([
      {
        ...entry(
          'diagnostic',
          {
            lib: 'agent',
            event: 'usage.recorded',
            payload: {
              actorRef: 'a',
              feature: 'f',
              modelId: 'm',
              inputTokens: 1,
              outputTokens: 1,
              costUsd: 2,
            },
          },
          0,
        ),
        createdAt: new Date(now - 2000),
      },
    ]);
    const service = new AiUsageService(storage);
    const result = await service.getUsage({ windowMs: 60_000 });
    expect(result.spend.totalUsd).toBe(2);
    expect(result.truncated).toBe(false);
    expect(service.prometheusEnabled).toBe(false);
  });
});

describe('AiUsageService Prometheus registry', () => {
  it('subscribes only when aiMetrics.prometheus is on, and stops at shutdown', async () => {
    const { channel } = await import('node:diagnostics_channel');
    const usageChannel = channel('aviary:agent:usage.recorded');
    const off = new AiUsageService(new InMemoryStorageProvider(), {});
    off.onModuleInit();
    expect(usageChannel.hasSubscribers).toBe(false);

    const on = new AiUsageService(new InMemoryStorageProvider(), {
      aiMetrics: { prometheus: true },
    });
    on.onModuleInit();
    usageChannel.publish({
      payload: {
        actorRef: 'a',
        feature: 'f',
        modelId: 'm',
        inputTokens: 1,
        outputTokens: 0,
        costUsd: 0.5,
      },
    });
    expect(on.prometheus()).toContain(
      'aviary_ai_cost_usd_total{feature="f",model="m",provider="unknown",cost_source="provider",platform="false"} 0.5',
    );
    on.onApplicationShutdown();
    expect(usageChannel.hasSubscribers).toBe(false);
  });
});
