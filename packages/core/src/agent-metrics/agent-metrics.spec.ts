// packages/core/src/agent-metrics/agent-metrics.spec.ts
import diagnostics_channel from 'node:diagnostics_channel';
import { describe, expect, it } from 'vitest';
import { agentEventOfEntry, readRun, readUsage } from './agent-events.js';
import { AgentMetricsRegistry, agentMetricPoints } from './agent-metrics.js';
import { subscribeAgentObservations } from './subscribe-agent-events.js';

const usage = {
  actorRef: 'user:42',
  feature: 'agent:tutor',
  purpose: 'chat',
  modelId: 'claude-sonnet-4-5',
  provider: 'anthropic',
  inputTokens: 1200,
  outputTokens: 300,
  cacheReadTokens: 800,
  costUsd: 0.0123,
  costSource: 'provider',
  runId: 'run-1',
  threadId: 'thread-1',
};

const finished = {
  runId: 'run-1',
  threadId: 'thread-1',
  actorId: 'user:42',
  agentName: 'tutor',
  steps: 2,
  inputTokens: 1200,
  outputTokens: 300,
  durationMs: 4200,
  queueMs: 40,
  modelMs: 3100,
  toolsMs: 900,
  modelCalls: 2,
  toolCalls: 2,
  costUsd: 0.0123,
  modelId: 'claude-sonnet-4-5',
  stepTimings: [
    {
      step: 0,
      modelMs: 1800,
      toolsMs: 900,
      tools: [
        { toolCallId: 'a', toolName: 'search', ms: 700 },
        { toolCallId: 'b', toolName: 'fetch', ms: 650 },
      ],
    },
    { step: 1, modelMs: 1300, toolsMs: 0, tools: [] },
  ],
};

describe('agent event readers', () => {
  it('reads a priced usage row', () => {
    const u = readUsage(usage);
    expect(u).toMatchObject({
      feature: 'agent:tutor',
      model: 'claude-sonnet-4-5',
      provider: 'anthropic',
      costSource: 'provider',
      platform: false,
      costUsd: 0.0123,
      requests: 1,
    });
  });

  it('marks an unpriced row with cost_source none and the platform payer', () => {
    const u = readUsage({
      actorRef: '@platform',
      feature: 'transcribe',
      modelId: 'whisper-1',
      inputTokens: 0,
      outputTokens: 0,
      audioSeconds: 61,
      requests: 3,
    });
    expect(u).toMatchObject({
      costSource: 'none',
      platform: true,
      provider: 'unknown',
      audioSeconds: 61,
      requests: 3,
    });
    expect(u?.costUsd).toBeUndefined();
  });

  it('reads run.failed context from `context`', () => {
    const r = readRun('run.failed', {
      runId: 'r',
      code: 'run_failed',
      message: 'secret',
      durationMs: 10,
      context: { actorId: 'u', agentName: 'billing' },
    });
    expect(r).toMatchObject({
      status: 'failed',
      agent: 'billing',
      code: 'run_failed',
      durationMs: 10,
    });
    expect(JSON.stringify(r)).not.toContain('secret');
  });

  it('defaults the agent name and tolerates an old run.finished without timings', () => {
    const r = readRun('run.finished', {
      runId: 'r',
      threadId: 't',
      steps: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    expect(r).toMatchObject({ status: 'completed', agent: 'default', stepTimings: [] });
    expect(r?.queueMs).toBeUndefined();
  });

  it('finds the agent event in both stored shapes', () => {
    expect(
      agentEventOfEntry({ type: 'agent', content: { event: 'usage.recorded', ...usage } })?.event,
    ).toBe('usage.recorded');
    expect(
      agentEventOfEntry({
        type: 'diagnostic',
        content: { lib: 'agent', event: 'run.finished', payload: finished },
      })?.payload,
    ).toBe(finished);
    expect(
      agentEventOfEntry({ type: 'diagnostic', content: { lib: 'media', event: 'x', payload: {} } }),
    ).toBeNull();
    // A span entry (`phase`) is not a point event.
    expect(
      agentEventOfEntry({
        type: 'diagnostic',
        content: { lib: 'agent', event: 'llm.turn', phase: 'asyncEnd' },
      }),
    ).toBeNull();
  });
});

describe('agentMetricPoints', () => {
  it('never puts actor, run or thread on a metric', () => {
    const points = [
      ...agentMetricPoints(readUsage(usage)!),
      ...agentMetricPoints(readRun('run.finished', finished)!),
    ];
    for (const p of points) {
      for (const key of Object.keys(p.attributes)) {
        expect(['actorRef', 'actor', 'runId', 'run_id', 'threadId', 'thread_id']).not.toContain(
          key,
        );
      }
      expect(JSON.stringify(p.attributes)).not.toContain('user:42');
      expect(JSON.stringify(p.attributes)).not.toContain('run-1');
    }
  });

  it('emits tokens per direction and tool durations per tool', () => {
    const points = agentMetricPoints(readUsage(usage)!);
    expect(points.filter((p) => p.metric === 'tokens').map((p) => p.attributes.direction)).toEqual([
      'in',
      'out',
      'cache_read',
    ]);
    const run = agentMetricPoints(readRun('run.finished', finished)!);
    expect(run.filter((p) => p.metric === 'toolDurationMs').map((p) => p.attributes.tool)).toEqual([
      'search',
      'fetch',
    ]);
    expect(run.find((p) => p.metric === 'runQueueMs')).toMatchObject({
      value: 40,
      attributes: { agent: 'tutor', status: 'completed' },
    });
  });
});

describe('AgentMetricsRegistry', () => {
  it('renders _total counters and cumulative histograms', () => {
    const registry = new AgentMetricsRegistry();
    registry.observe(readUsage(usage)!);
    registry.observe(readUsage(usage)!);
    registry.observe(readRun('run.finished', finished)!);
    const text = registry.prometheus();
    expect(text).toContain('# TYPE aviary_ai_cost_usd_total counter');
    expect(text).toContain(
      'aviary_ai_cost_usd_total{feature="agent:tutor",model="claude-sonnet-4-5",provider="anthropic",cost_source="provider",platform="false"} 0.0246',
    );
    expect(text).toContain(
      'aviary_ai_tokens_total{direction="in",feature="agent:tutor",model="claude-sonnet-4-5"} 2400',
    );
    expect(text).toContain(
      'aviary_agent_run_duration_ms_bucket{agent="tutor",status="completed",le="2500"} 0',
    );
    expect(text).toContain(
      'aviary_agent_run_duration_ms_bucket{agent="tutor",status="completed",le="5000"} 1',
    );
    expect(text).toContain(
      'aviary_agent_run_duration_ms_bucket{agent="tutor",status="completed",le="+Inf"} 1',
    );
    expect(text).toContain(
      'aviary_agent_run_duration_ms_sum{agent="tutor",status="completed"} 4200',
    );
    expect(text).toContain('aviary_agent_tool_duration_ms_count{tool="search"} 1');
  });

  it('is empty before anything is observed', () => {
    expect(new AgentMetricsRegistry().prometheus()).toBe('');
  });

  it('caps series per metric and reports the drops', () => {
    const registry = new AgentMetricsRegistry({ maxSeriesPerMetric: 1 });
    registry.observe(readUsage({ ...usage, feature: 'a' })!);
    registry.observe(readUsage({ ...usage, feature: 'b' })!);
    const text = registry.prometheus();
    expect(text).not.toContain('feature="b"');
    expect(text).toContain('aviary_ai_metrics_dropped_series_total{metric="aviary_ai_cost_usd"} 1');
  });
});

describe('subscribeAgentObservations', () => {
  it('reads envelopes from the aviary:agent channels and unsubscribes', () => {
    const seen: string[] = [];
    const off = subscribeAgentObservations((o) => seen.push(o.kind));
    diagnostics_channel
      .channel('aviary:agent:usage.recorded')
      .publish({ v: 1, ts: 1, lib: 'agent', event: 'usage.recorded', payload: usage });
    diagnostics_channel
      .channel('aviary:agent:run.finished')
      .publish({ v: 1, ts: 1, lib: 'agent', event: 'run.finished', payload: finished });
    diagnostics_channel.channel('aviary:agent:run.started').publish({ payload: {} });
    expect(seen).toEqual(['usage', 'run']);
    off();
    expect(diagnostics_channel.channel('aviary:agent:usage.recorded').hasSubscribers).toBe(false);
  });

  it('never throws back into the publisher', () => {
    const off = subscribeAgentObservations(() => {
      throw new Error('boom');
    });
    expect(() =>
      diagnostics_channel.channel('aviary:agent:usage.recorded').publish({ payload: usage }),
    ).not.toThrow();
    off();
  });
});
