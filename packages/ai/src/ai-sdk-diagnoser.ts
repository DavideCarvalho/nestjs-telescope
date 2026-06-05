// packages/ai/src/ai-sdk-diagnoser.ts
import type { DiagnoseContext, ExceptionDiagnoser } from '@dudousxd/nestjs-telescope';
import { type LanguageModel, generateText } from 'ai';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';

/**
 * Default cap on generated tokens. The system prompt asks for a bounded (~400
 * word) report, but we ALSO cap at the API level so a runaway model can't produce
 * a huge, expensive response. ~1024 tokens comfortably fits the four-section
 * format.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

/**
 * Hard wall-clock timeout for one diagnosis. A diagnosis is a "nice to have" on
 * top of the exception data, never on a request's critical path — so if the model
 * is slow we abort rather than let a request/alert hang. 30s is generous for a
 * single short completion while still bounding the worst case.
 */
const DIAGNOSIS_TIMEOUT_MS = 30_000;

/** Options for {@link createAiSdkDiagnoser}. */
export interface AiSdkDiagnoserOptions {
  /**
   * The Vercel AI SDK `LanguageModel` to diagnose with. Provider-agnostic: pass
   * `bedrock('...')`, `openai('...')`, `anthropic('...')`, or any AI-SDK model —
   * this package depends on `ai` only as a PEER, so the host owns the provider.
   */
  model: LanguageModel;
  /** Max tokens to generate. Default {@link DEFAULT_MAX_OUTPUT_TOKENS} (1024). */
  maxOutputTokens?: number;
  /**
   * Override the per-diagnosis timeout (ms). Default
   * {@link DIAGNOSIS_TIMEOUT_MS} (30s). On timeout the call REJECTS (core handles
   * it: the on-demand endpoint → 502, auto-mode → swallow).
   */
  timeoutMs?: number;
}

/**
 * Build an {@link ExceptionDiagnoser} backed by the Vercel AI SDK's
 * `generateText`. Plug the result into Telescope's `ai.diagnoser`:
 *
 * ```ts
 * import { bedrock } from '@ai-sdk/amazon-bedrock';
 * import { createAiSdkDiagnoser } from '@dudousxd/nestjs-telescope-ai';
 *
 * TelescopeModule.forRoot({
 *   ai: {
 *     diagnoser: createAiSdkDiagnoser({ model: bedrock('anthropic.claude-3-5-sonnet-20240620-v1:0') }),
 *     mode: 'auto',
 *   },
 * });
 * ```
 *
 * Behaviour:
 *  - Sends the carefully engineered {@link SYSTEM_PROMPT} plus a labelled context
 *    message built from the (already-redacted) exception/route/queries.
 *  - Bounds output via `maxOutputTokens` and disables the SDK's internal retries
 *    (`maxRetries: 0`) — we own a single hard timeout instead of stacked retries.
 *  - Races against a 30s `AbortController`; a timeout or model error REJECTS, and
 *    core decides what to do (never crashes the host).
 */
export function createAiSdkDiagnoser(options: AiSdkDiagnoserOptions): ExceptionDiagnoser {
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const timeoutMs = options.timeoutMs ?? DIAGNOSIS_TIMEOUT_MS;

  return {
    async diagnose(context: DiagnoseContext): Promise<string> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      try {
        const result = await generateText({
          model: options.model,
          system: SYSTEM_PROMPT,
          prompt: buildUserPrompt(context),
          maxOutputTokens,
          // We own the timeout + the higher-level cache/retry policy; stacked SDK
          // retries would multiply the worst-case latency past our abort window.
          maxRetries: 0,
          abortSignal: controller.signal,
        });
        return result.text;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export { DEFAULT_MAX_OUTPUT_TOKENS, DIAGNOSIS_TIMEOUT_MS };
