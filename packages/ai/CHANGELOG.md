# @dudousxd/nestjs-telescope-ai

## 1.11.0

### Minor Changes

- [#17](https://github.com/DavideCarvalho/nestjs-telescope/pull/17) [`76228a3`](https://github.com/DavideCarvalho/nestjs-telescope/commit/76228a3a33e4e6d649cd8343646472feff97ed16) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Ecosystem improvements across the telescope packages.

  - **Nested trace / batch waterfall view.** Traces and batches now render as a
    nested waterfall, showing child spans nested under their parents with relative
    offsets and durations so the critical path of a request is visible at a glance.
  - **Pulse-style outlier & rollup cards.** New overview cards surface the slowest
    endpoints, slowest queries, slowest jobs, and slowest outbound calls, plus
    load-by-user and CPU/memory history, in the spirit of Laravel Pulse rollups.
  - **Metric-threshold alert rules.** Alerts can now fire on metric thresholds
    (p95 / p99 latency, cache-hit ratio) in addition to existing rules, with
    shared-storage exception deduplication so the same exception is not alerted
    multiple times across replicas.
  - **Improved N+1 detection.** Detection now recognizes the 1+N loop pattern and
    is duration-weighted, reducing false positives and prioritizing the queries
    that actually cost time.
  - **On-demand CPU flamegraph profiling.** A strictly-opt-in `profiling` option
    (OFF by default) captures V8 CPU profiles via Node's `inspector`, aggregates
    them into a self/total frame tree, and persists them as `cpu_profile` entries
    correlated to their request batch. The dashboard gains a Profiles tab with a
    dependency-light flamegraph renderer, a hot-functions table, and an
    "arm next N requests" trigger. When profiling is disabled there is zero
    inspector usage and no request-path cost beyond a single boolean check.
  - **`TelescopeUiModule.forRootAsync`.** The UI module now mirrors
    `TelescopeModule.forRootAsync`, resolving dashboard options via DI.
  - **Realtime dashboards / SSE live-tail.** Dashboards update in realtime over an
    `@Sse` invalidation stream (falling back to polling) with a LIVE indicator.
  - **Packaging hygiene.** `sideEffects` is now declared on each publishable
    package to enable safe tree-shaking for downstream bundlers.
  - **Independent versioning.** The changeset `fixed` group was removed so packages
    version independently going forward.

### Patch Changes

- [#17](https://github.com/DavideCarvalho/nestjs-telescope/pull/17) [`76228a3`](https://github.com/DavideCarvalho/nestjs-telescope/commit/76228a3a33e4e6d649cd8343646472feff97ed16) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Packaging hygiene + `TelescopeUiModule.forRootAsync`.

  - `TelescopeUiModule` now exposes `forRootAsync({ imports, inject, useFactory, path })`, mirroring `TelescopeModule.forRootAsync`: dashboard options (`assetsDir`) are resolved via DI. As with the core module, the mount `path` is bound at module-build time and is passed statically on the config object (the static value also drives the serve-time asset-base rewrite, so it always matches the route).
  - Added `"sideEffects"` to each publishable package to enable safe tree-shaking for downstream bundlers:
    - `false` on the pure watcher / helper / provider packages (ai, bullmq, cache, events, logs, mail, mikro-orm, mikro-orm-watcher, otel, prisma, redis, redis-watcher, sqs, typeorm, testing) — their entrypoints only re-export classes/types with no module-load side effects.
    - `["./dist/schedule.watcher.js"]` on schedule, which carries a load-bearing bare `import 'reflect-metadata'`.
    - `["./dist/server/*.js", "**/*.css"]` on ui, whose server module/controller emit decorator metadata at load and whose bundled SPA ships CSS.
    - core is left unmarked (treated as side-effecting) because its decorator metadata emit spans many directories.

## 1.10.0

## 1.9.1

## 1.9.0

## 1.8.0

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
