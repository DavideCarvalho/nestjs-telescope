// packages/official/src/ai-usage.ts
import { publishAgentObservation, readUsage, telescopeRecord } from '@dudousxd/nestjs-telescope';
import { asRecord, bool, num, str } from './read.js';

/**
 * The fields of `@nestjs/ai`'s `AiUsageEvent` this reads, declared structurally (every field
 * optional) so a function taking it is assignable to `onUsage` without importing `@nestjs/ai`, and
 * a 0.0.x shape change degrades to fewer fields instead of a type error.
 */
export interface NestAiUsageEvent {
  label?: string;
  model?: { name?: string; provider?: string; modelId?: string };
  step?: number;
  attempt?: number;
  fallback?: boolean;
  stream?: boolean;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
  };
  cost?: number;
  durationMs?: number;
  finishReason?: string;
}

export interface TelescopeAiUsageOptions {
  /** The AI screen's "feature" for an event. Default: the call's `label`, else `'default'`. */
  feature?: (event: NestAiUsageEvent) => string;
  /**
   * Who pays for the call: a user/tenant ref, or `'@platform'` for platform spend. Shown on the AI
   * screen's "by actor" breakdown only, never a metric label. Default `'@platform'`.
   */
  actor?: (event: NestAiUsageEvent) => string | undefined;
  /**
   * `@nestjs/ai` reports `cost` in the unit of the model's `pricing`. Telescope's spend is in US
   * dollars, so the default treats it as USD; convert here when your pricing is in another unit
   * (return `undefined` to record the call as unpriced).
   */
  toUsd?: (cost: number, event: NestAiUsageEvent) => number | undefined;
  /** Record an `agent` entry per model call (the AI screen, the trace waterfall). Default `true`. */
  record?: boolean;
  /**
   * Count the call in the AI metrics (`aiMetrics.prometheus` and the otel AI exporter), through the
   * same registry as `@dudousxd/nestjs-agent`'s usage. Default `true`.
   */
  metrics?: boolean;
}

/** The function `telescopeAiUsage()` returns: hand it to `onUsage`. Never throws. */
export type TelescopeAiUsageListener = (event: NestAiUsageEvent) => void;

/**
 * An `onUsage` listener for `@nestjs/ai`: `AiModule.forRoot({ onUsage: telescopeAiUsage() })`, or a
 * call's own `onUsage`. Each model call that answered becomes a `usage.recorded` row, in the shape
 * Telescope's AI screen already reads from `@dudousxd/nestjs-agent` — tokens (cached input as
 * `cacheReadTokens`), cost, feature (the call's `label`), model and provider — and is counted in
 * the AI metrics. The cost is `costSource: 'estimate'`: `@nestjs/ai` prices it from the `pricing`
 * you configured, not from the provider's bill.
 *
 * The listener runs in the call's async context, so the entry joins the request or job batch (and
 * trace) that made the call. Use it in ONE place: `@nestjs/ai` calls the module's `onUsage` AND the
 * call's, so attaching it to both counts each call twice.
 *
 * To keep an `onUsage` you already have, call both:
 * ```ts
 * const toTelescope = telescopeAiUsage();
 * AiModule.forRoot({ onUsage: (event) => { toTelescope(event); return myOnUsage(event); } });
 * ```
 */
export function telescopeAiUsage(options: TelescopeAiUsageOptions = {}): TelescopeAiUsageListener {
  const record = options.record !== false;
  const metrics = options.metrics !== false;
  return (event) => {
    try {
      const payload = usagePayload(event, options);
      if (payload === null) return;
      if (record) {
        const fallback = payload.fallback === true;
        telescopeRecord({
          type: 'agent',
          familyHash: `${String(payload.feature)}:${String(payload.modelId)}`,
          content: payload,
          tags: fallback ? ['ai', 'ai:fallback'] : ['ai'],
          // Reported on completion: anchor createdAt to when the call started.
          ...(typeof payload.durationMs === 'number'
            ? {
                durationMs: payload.durationMs,
                startedAt: new Date(Date.now() - Math.max(0, payload.durationMs)),
              }
            : {}),
        });
      }
      if (metrics) {
        const observation = readUsage(payload);
        if (observation !== null) publishAgentObservation(observation);
      }
    } catch {
      // `@nestjs/ai` logs what a listener throws; Telescope must not add noise to the app's logs.
    }
  };
}

/**
 * `AiUsageEvent` → the `agent` entry content: `{ event: 'usage.recorded', ...ledger fields }`, the
 * same keys `readUsage` reads, plus `@nestjs/ai`'s own (step, attempt, fallback, stream,
 * finishReason, reasoning and total tokens). `null` when it is not an object.
 */
export function usagePayload(
  event: NestAiUsageEvent,
  options: Pick<TelescopeAiUsageOptions, 'feature' | 'actor' | 'toUsd'> = {},
): Record<string, unknown> | null {
  const e = asRecord(event);
  if (e === null) return null;
  const model = asRecord(e.model) ?? {};
  const usage = asRecord(e.usage) ?? {};
  const cost = num(e.cost);
  const costUsd =
    cost === undefined || options.toUsd === undefined ? cost : options.toUsd(cost, event);
  const payload: Record<string, unknown> = {
    event: 'usage.recorded',
    source: '@nestjs/ai',
    feature: options.feature?.(event) ?? str(e.label) ?? 'default',
    actorRef: options.actor?.(event) ?? '@platform',
    modelId: str(model.modelId) ?? 'unknown',
    provider: str(model.provider) ?? 'unknown',
    inputTokens: num(usage.inputTokens) ?? 0,
    outputTokens: num(usage.outputTokens) ?? 0,
    totalTokens: num(usage.totalTokens) ?? 0,
    cacheReadTokens: num(usage.cachedInputTokens) ?? 0,
    reasoningTokens: num(usage.reasoningTokens) ?? 0,
    requests: 1,
  };
  const modelName = str(model.name);
  if (modelName !== undefined) payload.modelName = modelName;
  if (costUsd !== undefined && Number.isFinite(costUsd)) {
    payload.costUsd = costUsd;
    payload.costSource = 'estimate';
  }
  for (const key of ['step', 'attempt', 'durationMs'] as const) {
    const value = num(e[key]);
    if (value !== undefined) payload[key] = value;
  }
  for (const key of ['fallback', 'stream'] as const) {
    const value = bool(e[key]);
    if (value !== undefined) payload[key] = value;
  }
  const finishReason = str(e.finishReason);
  if (finishReason !== undefined) payload.finishReason = finishReason;
  return payload;
}
