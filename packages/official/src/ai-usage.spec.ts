import {
  type AgentObservation,
  type RecordInput,
  setTelescopeRecordSink,
  subscribeAgentObservations,
} from '@dudousxd/nestjs-telescope';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { telescopeAiUsage, usagePayload } from './ai-usage.js';

const event = {
  label: 'triage',
  model: { name: 'fast', provider: 'anthropic.messages', modelId: 'claude-haiku-5-5' },
  step: 0,
  attempt: 1,
  fallback: false,
  stream: false,
  usage: {
    inputTokens: 1000,
    outputTokens: 200,
    totalTokens: 1200,
    cachedInputTokens: 400,
    reasoningTokens: 50,
  },
  cost: 0.0042,
  durationMs: 830,
  finishReason: 'stop',
};

let recorded: RecordInput[] = [];
let observations: AgentObservation[] = [];
let off: () => void = () => undefined;

beforeEach(() => {
  recorded = [];
  observations = [];
  setTelescopeRecordSink((input) => recorded.push(input));
  off = subscribeAgentObservations((o) => observations.push(o));
});
afterEach(() => {
  setTelescopeRecordSink(null);
  off();
});

describe('usagePayload', () => {
  it('maps AiUsageEvent to the usage.recorded ledger keys', () => {
    expect(usagePayload(event)).toEqual({
      event: 'usage.recorded',
      source: '@nestjs/ai',
      feature: 'triage',
      actorRef: '@platform',
      modelId: 'claude-haiku-5-5',
      provider: 'anthropic.messages',
      modelName: 'fast',
      inputTokens: 1000,
      outputTokens: 200,
      totalTokens: 1200,
      cacheReadTokens: 400,
      reasoningTokens: 50,
      requests: 1,
      costUsd: 0.0042,
      costSource: 'estimate',
      step: 0,
      attempt: 1,
      durationMs: 830,
      fallback: false,
      stream: false,
      finishReason: 'stop',
    });
  });

  it('an unpriced call has no costUsd; toUsd converts or unprices', () => {
    const { cost: _cost, ...unpriced } = event;
    expect(usagePayload(unpriced)).not.toHaveProperty('costUsd');
    expect(usagePayload(event, { toUsd: (c) => c * 2 })?.costUsd).toBeCloseTo(0.0084);
    expect(usagePayload(event, { toUsd: () => undefined })).not.toHaveProperty('costUsd');
  });

  it('feature and actor are configurable; a sparse event yields defaults, not a throw', () => {
    const p = usagePayload(event, { feature: () => 'support', actor: () => 'tenant:9' });
    expect(p).toMatchObject({ feature: 'support', actorRef: 'tenant:9' });
    expect(usagePayload({})).toMatchObject({
      feature: 'default',
      modelId: 'unknown',
      provider: 'unknown',
      inputTokens: 0,
    });
    expect(usagePayload(null as never)).toBeNull();
  });
});

describe('telescopeAiUsage', () => {
  it('records an agent entry and publishes one usage observation', () => {
    telescopeAiUsage()(event);
    expect(recorded).toEqual([
      expect.objectContaining({
        type: 'agent',
        familyHash: 'triage:claude-haiku-5-5',
        durationMs: 830,
        tags: ['ai'],
        content: expect.objectContaining({ event: 'usage.recorded', cacheReadTokens: 400 }),
      }),
    ]);
    expect(observations).toEqual([
      expect.objectContaining({
        kind: 'usage',
        feature: 'triage',
        model: 'claude-haiku-5-5',
        provider: 'anthropic.messages',
        costUsd: 0.0042,
        costSource: 'estimate',
        platform: true,
        inputTokens: 1000,
        cacheReadTokens: 400,
        requests: 1,
      }),
    ]);
  });

  it('tags fallback calls; record and metrics can be switched off', () => {
    telescopeAiUsage({ metrics: false })({ ...event, fallback: true });
    expect(recorded[0]?.tags).toEqual(['ai', 'ai:fallback']);
    expect(observations).toHaveLength(0);
    telescopeAiUsage({ record: false })(event);
    expect(recorded).toHaveLength(1);
    expect(observations).toHaveLength(1);
  });

  it('never throws, even when an option callback does', () => {
    const listener = telescopeAiUsage({
      feature: () => {
        throw new Error('boom');
      },
    });
    expect(() => listener(event)).not.toThrow();
  });

  it('composes with an existing onUsage', () => {
    const seen: unknown[] = [];
    const toTelescope = telescopeAiUsage();
    const onUsage = (e: typeof event) => {
      toTelescope(e);
      seen.push(e);
    };
    onUsage(event);
    expect(seen).toHaveLength(1);
    expect(recorded).toHaveLength(1);
  });
});
