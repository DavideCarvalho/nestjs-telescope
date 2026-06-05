// packages/core/src/config/sampling.ts
import type { RecordInput } from '../entry/entry.js';
import type { SamplingConfig, SamplingRule } from './options.js';

/** Log levels that count as an error for tail-sampling's `keepErrors` — a `warn`
 *  / `error` / `fatal` line is exactly what you never want sampled away. */
const ERROR_LOG_LEVELS = new Set(['warn', 'error', 'fatal']);

/**
 * Pragmatic, cheap structural error check used by tail-sampling's `keepErrors`.
 * Reads only shallow, already-present fields — no deep walk — so it stays on the
 * hot path. An entry "looks like an error" when:
 *  - its `tags` include `'failed'`, OR
 *  - `content.failed === true`, OR
 *  - `content.statusCode >= 500`, OR
 *  - `content.level` is `'warn'`, `'error'`, or `'fatal'` (a Log entry) — so a
 *    host can sample logs aggressively (`{ log: { rate: 0.1, keepErrors: true } }`)
 *    yet never drop a warning or error line.
 */
export function isErrorEntry(input: RecordInput): boolean {
  if (input.tags?.includes('failed')) {
    return true;
  }
  const { content } = input;
  if (content === null || typeof content !== 'object') {
    return false;
  }
  if ('failed' in content && content.failed === true) {
    return true;
  }
  if ('statusCode' in content) {
    const { statusCode } = content;
    if (typeof statusCode === 'number' && statusCode >= 500) {
      return true;
    }
  }
  if ('level' in content) {
    const { level } = content;
    if (typeof level === 'string' && ERROR_LOG_LEVELS.has(level)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolves the keep-rate for a sampling entry. Discriminated purely by `typeof`
 * — a number is a bare rate, an object is a {@link SamplingRule}. No casts.
 */
function ruleRate(rule: number | SamplingRule): number {
  return typeof rule === 'number' ? rule : rule.rate;
}

/**
 * Projects a {@link SamplingConfig} down to bare per-type keep-rates for the
 * meta/dashboard contract, which only surfaces the headline rate. Keeps the
 * wire shape `Record<string, number>` stable so existing consumers (the UI's
 * `samplingNote`) don't need to learn about tail-sampling rule objects.
 */
export function samplingRates(sampling: SamplingConfig): Record<string, number> {
  const rates: Record<string, number> = {};
  for (const [type, rule] of Object.entries(sampling)) {
    rates[type] = ruleRate(rule);
  }
  return rates;
}

/**
 * Tail-sampling decision for one input. Plain-number per-type config behaves
 * exactly as a uniform keep-rate. A {@link SamplingRule} additionally always
 * keeps errors (`keepErrors`) and slow entries (`durationMs >= keepSlowMs`)
 * before falling back to the base rate. `random` is the injected 0–1 source.
 */
export function passesSampling(
  sampling: SamplingConfig,
  input: RecordInput,
  random: () => number,
): boolean {
  const rule = sampling[input.type] ?? sampling.default;
  if (rule === undefined) {
    return true;
  }

  if (typeof rule === 'object') {
    if (rule.keepErrors === true && isErrorEntry(input)) {
      return true;
    }
    if (
      rule.keepSlowMs !== undefined &&
      input.durationMs !== undefined &&
      input.durationMs !== null &&
      input.durationMs >= rule.keepSlowMs
    ) {
      return true;
    }
  }

  const rate = ruleRate(rule);
  if (rate >= 1) {
    return true;
  }
  if (rate <= 0) {
    return false;
  }
  return random() < rate;
}
