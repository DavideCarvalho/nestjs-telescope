# @dudousxd/nestjs-telescope-ai

AI-powered exception diagnosis for
[`@dudousxd/nestjs-telescope`](../../README.md). Turns a captured exception — its
class, message, stack, the route or page it came from, and the (already-redacted)
SQL that ran in the same request — into a concise markdown triage report: probable
root cause, where to look, a suggested fix, and a confidence rating.

It implements core's `ExceptionDiagnoser` SPI using the
[Vercel AI SDK](https://www.npmjs.com/package/ai) (`generateText`). The `ai`
package is a **peer dependency** and the model is **provider-agnostic** — you plug
in Bedrock, OpenAI, Anthropic, or any AI-SDK `LanguageModel`.

## Install

```sh
pnpm add @dudousxd/nestjs-telescope-ai ai
# plus your provider, e.g.
pnpm add @ai-sdk/amazon-bedrock
# or
pnpm add @ai-sdk/openai
```

## Usage

Pass `createAiSdkDiagnoser(...)` as `ai.diagnoser` on the module.

```ts
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { createAiSdkDiagnoser } from '@dudousxd/nestjs-telescope-ai';
import { bedrock } from '@ai-sdk/amazon-bedrock';

@Module({
  imports: [
    TelescopeModule.forRoot({
      ai: {
        diagnoser: createAiSdkDiagnoser({
          model: bedrock('anthropic.claude-3-5-sonnet-20240620-v1:0'),
          maxOutputTokens: 1024,
        }),
        mode: 'auto', // default 'on-demand'
      },
    }),
  ],
})
export class AppModule {}
```

With OpenAI instead:

```ts
import { openai } from '@ai-sdk/openai';

createAiSdkDiagnoser({ model: openai('gpt-4o-mini') });
```

## Modes

- **`on-demand`** (default) — diagnosis runs only when an operator clicks
  **Diagnose with AI** on an exception detail page in the dashboard
  (`POST <telescope>/api/exceptions/:id/diagnose`).
- **`auto`** — the first time a **new** exception family is seen, Telescope ALSO
  runs a fire-and-forget diagnosis on the flush path (never blocking it) and
  caches the result. If a `new-exception` alert fires for that family, the
  diagnosis is attached to the alert when it's ready within a short grace window
  (Slack renders a **Probable cause (AI)** section).

## How it works

- Results are cached per exception **family** (bounded, 24h TTL) so the same
  failure is diagnosed once. The dashboard shows a **cached** badge with a re-run
  (force) action. The cache is **per pod** — in a multi-replica deployment a
  family may be diagnosed up to once per pod.
- Each call sends a carefully engineered system prompt plus a labelled context
  message and is bounded by `maxOutputTokens` and a hard 30s `AbortController`
  timeout. A timeout or model error **rejects**; core handles it (the endpoint
  returns a safe 502, auto-mode swallows it) and **never** crashes the host.

## Privacy

The diagnoser only receives **already-redacted** content as stored by Telescope's
Recorder, and SQL is passed **without bindings** — query values never leave your
process just because diagnosis ran. Note that the exception message, stack, route,
and SQL shapes ARE sent to your configured model provider; scope the model/region
accordingly.
