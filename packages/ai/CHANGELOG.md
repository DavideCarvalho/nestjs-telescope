# @dudousxd/nestjs-telescope-ai

## 1.7.1

## 1.7.0

## 1.6.0

## 1.5.0

## 1.4.0

### Minor Changes

- [`7878ccc`](https://github.com/DavideCarvalho/nestjs-telescope/commit/7878ccc8ca912fd5fc4102c22a5b1c26331443d7) - AI-powered exception diagnosis.

  New package **`@dudousxd/nestjs-telescope-ai`**: `createAiSdkDiagnoser({ model })` implements core's `ExceptionDiagnoser` SPI using the Vercel AI SDK (`ai` is a peer dependency; the model is provider-agnostic — Bedrock / OpenAI / Anthropic / any AI-SDK `LanguageModel`). It turns a captured exception (class, message, stack), its sibling request (route/method/status/duration), and the request's recent **redacted** SQL into a markdown triage report — probable cause, where to look, a suggested fix, and a confidence rating — bounded by `maxOutputTokens` (default 1024) and a hard 30s timeout.

  Core gains an `ai` option (`{ diagnoser, mode? }`, shape defined in core so core stays AI-SDK-free):

  - **On-demand** (default): `POST <telescope>/api/exceptions/:id/diagnose` (behind the normal dashboard read guard) returns `{ markdown, cached }`. Results are cached per error family (bounded, 24h TTL); `?force=true` bypasses. 404 when AI is off or the entry isn't an exception; 502 (safe message) when the diagnoser fails.
  - **Auto** (`mode: 'auto'`): the first time a new exception family is seen, Telescope runs a fire-and-forget diagnosis on the flush path (never blocking capture) and caches it; a firing `new-exception` alert briefly awaits it and attaches it (Slack renders a "Probable cause (AI)" section). `meta.ai` advertises `{ enabled, mode }`.

  The UI adds a **Diagnose with AI** button on exception / client_exception detail pages (visible when `meta.ai.enabled`), rendering the markdown with loading + error states and a **cached** badge with a re-run (force) action.
