# @dudousxd/nestjs-telescope-otel

## 5.0.0

### Major Changes

- [#188](https://github.com/DavideCarvalho/nestjs-telescope/pull/188) [`1242fd8`](https://github.com/DavideCarvalho/nestjs-telescope/commit/1242fd889bcdb43037b08ec781f04de1fa1a7440) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Require Node.js 24 or newer: `engines.node` is now `>=24` (was `>=20`). CI tests on Node 24 and 26. `@dudousxd/nestjs-telescope` depends on `better-sqlite3` 12.11.1 (was 11.10.0, which neither ships a prebuild for nor compiles on Node 26).

  Removed, with no replacement alias (see the docs' Upgrading page):

  - `@dudousxd/nestjs-telescope`: the `alerts.webhookUrl` option. Use `alerts.channels: [webhookChannel(url)]`, which sends the same payload. `alerts.channels` is now required.
  - `@dudousxd/nestjs-telescope-ui`: `BarChartCard`'s `onBarClick` prop (use `onSelect`), and the `chartTheme`, `tooltipContentStyle`, `tooltipLabelStyle`, `tooltipItemStyle` and `axisTickStyle` exports (`ChartContainer` and `ChartTooltipContent` style the charts). `TelescopeMeta`'s `tracesEnabled`, `ai`, `entryTypes`, `dashboards` and `profiling` are now required, as the server always sends them.

### Patch Changes

- Updated dependencies [[`1242fd8`](https://github.com/DavideCarvalho/nestjs-telescope/commit/1242fd889bcdb43037b08ec781f04de1fa1a7440)]:
  - @dudousxd/nestjs-telescope@4.0.0

## 4.0.0

### Major Changes

- [#185](https://github.com/DavideCarvalho/nestjs-telescope/pull/185) [`b91f0ca`](https://github.com/DavideCarvalho/nestjs-telescope/commit/b91f0caebd74b0027043a56c0cebdd7102696f49) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Telescope works with your app's OpenTelemetry SDK instead of running its own exporter.

  - New `telescopeSpanProcessor(options?)` (`@dudousxd/nestjs-telescope-otel/span-processor`, also on the main entry): add it to `NodeSDK({ spanProcessors })` and your app's spans become `span` entries in the request's trace waterfall. Spans a watcher already records are skipped with the driver spans under them: the HTTP server span (request middleware), SQL driver spans while the TypeORM/MikroORM logger or the Prisma watcher is on, ioredis/redis spans while the redis watcher is on, and the HTTP client span (undici or `http`) of a `fetch` or axios call the http-client watcher records (axios requests now run inside the watcher's scope through their adapter; other http calls, like the AWS SDK's, still come through). When sampling can drop a covering watcher's entries, the processor holds the call's span and records it only when the entry was dropped, so sampled-out SQL still shows in the waterfall. Telescope's own spans and requests to the dashboard are skipped too. Options: `ignore`, `maxSpansPerTrace` (200), `maxAttributes` (64), `maxAttributeLength` (2048). The subpath loads no OpenTelemetry package and no Nest, so it can be imported in the SDK bootstrap file.
  - Telescope's storage reads and writes run with OpenTelemetry tracing suppressed, so they no longer show up in the app's traces.
  - `TelescopeOtelExporter` no longer re-exports `span` entries (they came from the SDK).
  - core: new `span` entry type and `RecordInput.spanId`; the dashboard lists **Spans** when the processor is on.
  - core: the trace waterfall nests entries that name a parent span (`content.parentSpanId`) under the entry with that `spanId`, and falls back to time containment for the rest.
  - Every entry's `createdAt` is when its work started. The request middleware, the http-client watcher, the TypeORM/MikroORM/Prisma query watchers, the redis, BullMQ, schedule, mail and MikroORM flush/transaction watchers, the official channel watchers, the AI usage listener and CPU profiles pass `RecordInput.startedAt`, so the waterfall draws a request from offset 0 with its queries inside it. Redis and mail entries now carry `durationMs`. Observe reads `createdAt` as the start.
  - core: when many entries share a span id (every entry in a request carries the server span's id), the waterfall hangs children on the entry that owns the span (the `request` or `span` entry), and entries recorded inside a span nest under it.
  - mikro-orm: `created_at` has millisecond precision (`datetime(3)` on MySQL/MariaDB), so the waterfall no longer collapses a trace onto whole seconds. With the default `ensureSchema`, the schema revision bump re-runs `schema.update` on the next boot and alters the column (a table rebuild on MySQL). With `ensureSchema: false`, run `ALTER TABLE telescope_entries MODIFY created_at DATETIME(3) NOT NULL;`.

  **Breaking (otel):**

  - `TelescopeAiMetricsExporter` records on the global meter (`metrics.getMeter('telescope')`) and no longer runs a private OTLP `MeterProvider`. The `endpoint`, `path`, `headers`, `exportIntervalMs`, `timeoutMs` and `serviceName` options are removed and throw at boot: configure them on the SDK (`new NodeSDK({ serviceName, metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url, headers }), exportIntervalMillis })] })`). `flush()`, the second constructor argument and the `OtelMetricsSdk` type are removed; `{ meter }` passes a meter of your own.
  - The `@opentelemetry/sdk-metrics`, `@opentelemetry/exporter-metrics-otlp-http` and `@opentelemetry/resources` optional peers are dropped.

## 3.0.0

### Major Changes

- [#183](https://github.com/DavideCarvalho/nestjs-telescope/pull/183) [`1a1d056`](https://github.com/DavideCarvalho/nestjs-telescope/commit/1a1d0560b680349d4e1ce142a61910ddebcb9ae2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - One `authorize` option decides who may use the console.

  - `TelescopeModule.forRoot({ authorize })` covers the API, the live stream and the MCP endpoint; `mcpAuthorize` replaces it on MCP alone. `TelescopeUiModule.forRoot({ authorize })` covers the page and its assets, and `TelescopeOtelMetricsModule.forExporter(exporter, { authorize })` covers `GET /metrics`. With `forRootAsync`, `authorize` can come from the factory.
  - `authorize` takes a function `(ctx) => result`, an `@Injectable()` class implementing `ConsoleAuthorizer`, a lazy `() => import(...)`, `{ policy, ability }` for `@nestjs/authorization` (now an optional peer), or a gate name resolved by `@dudousxd/nestjs-authz`.
  - It returns `true`/`false`, `{ allowed }`, `{ allowed: false, reason: 'unauthenticated' }` or `{ redirectTo }`. Denials answer `403 { error: 'forbidden' }` or `401 { error: 'unauthenticated' }`; `redirectTo` gives a 302 for a page navigation and a 401 with `redirectTo` for an API call. A throw denies. A denied page navigation gets an "Access denied" page (403) or a "Sign in required" page (401).
  - New `authorizeByToken({ token })` checks `Authorization: Bearer <token>` in constant time, for coding agents on MCP and Prometheus on `/metrics`. `@UseConsoleAuthorize()` protects controllers you mount yourself with `routes: false`: with no argument it runs `TelescopeModule`'s `authorize`; list it above your authentication guard so that guard runs first. `ConsoleAuthorizeGuard` (or `ConsoleAuthorizeGuard.for({ authorize })`) and `ConsoleAuthorizeFilter` are the guard and the denial filter on their own.
  - The dashboard follows `redirectTo` from a 401 and shows an access-denied screen on a 403. `createTelescopeClient` takes an `onAccessDenied` callback.

  **Breaking:**

  - With no `authorize`, the console is open outside production and answers 403 to every request in production, with one warning at boot (also with `routes: false`). The production boot refusal ("refusing to mount undecorated routes with NODE_ENV=production") is removed, and `decorators` no longer count as protection on their own: keep authentication in `decorators` and move the authorization check to `authorize`.
  - `assertConsoleProtected`, `CONSOLE_DECORATORS_EXAMPLE` and `ConsoleProtectionHint` are removed.
  - otel: `requireProtectionInProduction` is removed. `/metrics` follows the console's rule, so it answers 403 in production until you set `authorize`. **If a Prometheus scraper reads `/metrics` without credentials today, it starts getting 403 after this upgrade:** set `authorize: authorizeByToken({ token: process.env.METRICS_TOKEN })` and give the scraper that bearer token, or `authorize: () => true` to keep `/metrics` open when the network already restricts it.

### Patch Changes

- Updated dependencies [[`1a1d056`](https://github.com/DavideCarvalho/nestjs-telescope/commit/1a1d0560b680349d4e1ce142a61910ddebcb9ae2)]:
  - @dudousxd/nestjs-telescope@3.0.0

## 2.0.1

### Patch Changes

- [#179](https://github.com/DavideCarvalho/nestjs-telescope/pull/179) [`3f6437a`](https://github.com/DavideCarvalho/nestjs-telescope/commit/3f6437ae527264cc5acbbd4be7c0b9ab060cfdc9) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Republish the 2.0 release as 2.0.1. The 2.0.0 versions on npm are an old accidental build from 2026-06-05 (deprecated at the time), so `changeset publish` skipped them as "already published" and `^2.0.0` installs that June build. 2.0.1 is the real 2.0: the first-party NestJS integration and route protection release, with no further changes.

## 2.0.0

### Major Changes

- [#178](https://github.com/DavideCarvalho/nestjs-telescope/pull/178) [`3222eae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/3222eae574429a9807784ba413e8f0e43c3d98d3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **Breaking:** `TelescopeOtelMetricsModule.forExporter(exporter, { decorators })` takes class decorators for the `GET /metrics` controller, applied to a fresh subclass per call; the controller is also marked open to `@nestjs/authorization`'s deny-by-default global guard, and a `Can()` passed in `decorators` is still enforced. `decorators` apply in every environment whenever given.

  **Production:** by default `/metrics` stays **outside** the console's production rule, so an undecorated scrape still boots with `NODE_ENV=production` (a Prometheus scrape usually runs unauthenticated inside the cluster). `/metrics` exposes your metrics: keep it reachable only by the scraper, with a network policy or `decorators`. The new `requireProtectionInProduction: true` (default `false`) puts it under the same rule as the console: in production, mounting it undecorated (an empty array counts as none) fails the boot; the rule checks only that decorators are present, not that they enforce auth. `routes: false` always boots.

  Requires `@dudousxd/nestjs-telescope@2` (the peer moves to `^2`). Migration: nothing, unless you want the scrape protected: pass `decorators: [UseGuards(AuthenticationGuard), Can(MetricsPolicy, 'scrape')]` (optionally with `requireProtectionInProduction: true`), or use `routes: false` and serve the scrape from your own controller.

- [#178](https://github.com/DavideCarvalho/nestjs-telescope/pull/178) [`3222eae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/3222eae574429a9807784ba413e8f0e43c3d98d3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `TelescopeOtelMetricsModule.forExporter(exporter, { routes: false })` mounts no controller and exports the exporter under `TELESCOPE_OTEL_EXPORTER`, so your own controller (a subclass of `TelescopeOtelMetricsController`, or one calling `exporter.prometheus()`) serves the scrape behind `@Can(...)` / `@UseGuards(...)`.

### Patch Changes

- Updated dependencies [[`3222eae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/3222eae574429a9807784ba413e8f0e43c3d98d3), [`3222eae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/3222eae574429a9807784ba413e8f0e43c3d98d3), [`3222eae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/3222eae574429a9807784ba413e8f0e43c3d98d3)]:
  - @dudousxd/nestjs-telescope@2.0.0

## 1.14.0

### Minor Changes

- [#175](https://github.com/DavideCarvalho/nestjs-telescope/pull/175) [`a884482`](https://github.com/DavideCarvalho/nestjs-telescope/commit/a884482066c847c7dfbb24945f50c72ba5b92d51) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - AI usage and agent run timings are first-class.

  - **AI screen** (`#/ai`): spend over the window (total, platform and estimated shares, by feature, model and top payers, over time), agent runs with a queue / model / tools bar, steps, tool calls, cost, model and status, the slowest and most expensive runs, a per-step breakdown with links to the trace waterfall, and the calls nobody priced. Backed by `GET <path>/api/ai`, summarized from the `aviary:agent:*` entries `@dudousxd/nestjs-agent` 1.38.0+ (core 0.60.0+) records. An app on an older agent lib gets an empty state that says so.
  - **Metrics** `aviary_ai_cost_usd_total`, `aviary_ai_tokens_total`, `aviary_ai_audio_seconds_total`, `aviary_ai_requests_total` (counters, as Prometheus names them) and `aviary_agent_run_duration_ms`, `aviary_agent_run_queue_ms`, `aviary_agent_run_model_ms`, `aviary_agent_run_tools_ms`, `aviary_agent_tool_duration_ms` (histograms), read straight from the diagnostics channels. No actor, run or thread attributes.
  - `aiMetrics: { prometheus: true }` serves them at `GET <path>/api/metrics` (Prometheus text format) behind the API gate. Off by default.
  - `TelescopeAiMetricsExporter` (`-otel`) pushes them over OTLP/HTTP from a private `MeterProvider`, with its own endpoint. `@opentelemetry/sdk-metrics`, `@opentelemetry/exporter-metrics-otlp-http` and `@opentelemetry/resources` are optional, lazily loaded peers.
  - An importable Grafana dashboard ships at `@dudousxd/nestjs-telescope-otel/grafana/aviary-ai-dashboard.json`.
  - `StackedAreaChartCard` takes an optional `colors` map.

## 1.13.1

### Patch Changes

- [`80392f0`](https://github.com/DavideCarvalho/nestjs-telescope/commit/80392f0e4d038b50b5c8703275cfd91e3328064b) - Add NestJS 12 to the supported peer range.

  NestJS 12.0.1 shipped the framework as pure ESM and raised its floor to Node >= 20.19. Telescope's
  packages are already `"type": "module"`, so the ESM shift is a non-event here — nothing needed
  porting, and every watcher, storage provider and dashboard route behaves identically on 11 and 12.

  The declared peer ranges (`@nestjs/common`/`@nestjs/core` at `>=10.0.0`, `>=11.0.0` for the UI
  package, and the satellite peers `@nestjs/bullmq`, `@nestjs/cache-manager`, `@nestjs/event-emitter`,
  `@nestjs/schedule`) already admitted a 12.x resolution, so no range changed — what changed is that
  the claim is now tested. Every package's dev and test matrix moved to the 12.x line, along with the
  example app and the memory-soak harness, and the whole suite builds, typechecks and passes there.

  Moving the example app and the soak harness matters for more than tidiness: leaving them on
  `@nestjs/platform-express@11` left a second `@nestjs/platform-express` major in the workspace, and
  pnpm's peer resolution then produced two distinct `@nestjs/core@12` instances. `tsc` correctly
  rejected the resulting `ModuleRef` from one instance where the other was expected. That is a
  workspace resolution artifact rather than a NestJS 12 incompatibility, but it is exactly the shape
  of breakage a consumer sees when they upgrade half a dependency graph.

  No behaviour change — peer ranges only affect what a package manager warns about on install.

## 1.13.0

### Minor Changes

- [`5fd5b30`](https://github.com/DavideCarvalho/nestjs-telescope/commit/5fd5b30cb4f90551b3a5f830f3cb588fb14ecd46) - Capture MikroORM flush/transaction lifecycle and export duration histograms.

  - `@dudousxd/nestjs-telescope-mikro-orm-watcher`: the model watcher now also records **flush** (`{ kind: 'flush' }`) and **transaction** (`{ kind: 'transaction', outcome }`) entries with a measured `durationMs`, in addition to entity create/update/delete (now tagged `{ kind: 'entity' }`). Timing is keyed per-EntityManager via a WeakMap, so concurrent flushes from different forked EMs never share a start slot.
  - `@dudousxd/nestjs-telescope-otel`: `mapInput` now emits `telescope_mikroorm_flush_total` + `telescope_mikroorm_flush_duration_ms`, `telescope_mikroorm_transaction_total{outcome}` + `telescope_mikroorm_transaction_duration_ms`, and — when a `diagnostic` entry carries a `durationMs` — a `telescope_diagnostic_duration_ms{lib,event}` histogram alongside the existing `telescope_diagnostic_total` counter. This lets MikroORM flush/transaction timing and duration-bearing diagnostics events become Grafana-queryable `histogram_quantile` metrics.

## 1.12.0

### Minor Changes

- [`0d1f7ae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/0d1f7ae2afe6b308b407eabc781f0a308a260d85) - Export everything Telescope records to OpenTelemetry/Grafana. `TelescopeOtelExporter` (a `TelescopeExtension`) pushes **complete** metrics (counted pre-sampling) into the OTel Meter for OTLP and a dependency-free Prometheus `/metrics` scrape (`TelescopeOtelMetricsModule.forExporter`), and **sampled** spans into the OTel Tracer. Durations export as real Prometheus histograms (`_bucket{le}` + `_sum`/`_count`) with boundaries aligned to the OTel Meter, so `histogram_quantile` works in Grafana. Metric cardinality is bounded per metric (`maxSeriesPerMetric`, default 2000) with a visible `telescope_metrics_dropped_series_total{metric}` instead of unbounded growth. `@nestjs/common` and `@nestjs/core` are optional peers (only the `/metrics` module needs them; the exporter itself is NestJS-free).

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

## 1.3.0

## 1.2.1

## 1.2.0

## 1.1.0

### Patch Changes

- Updated dependencies [[`c2423f3`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c2423f330be3f9b92c0dbf2348220bf8740dab86), [`d8173d4`](https://github.com/DavideCarvalho/nestjs-telescope/commit/d8173d4c5d362814aa0fcdb0bfb35fd353b3d1a8), [`d200d15`](https://github.com/DavideCarvalho/nestjs-telescope/commit/d200d158f927e6a67396e594b32bfd0a0b3424e4), [`953ae12`](https://github.com/DavideCarvalho/nestjs-telescope/commit/953ae12fd35e42df3b806d6bbec6b49e3e3c71fb), [`4ceb884`](https://github.com/DavideCarvalho/nestjs-telescope/commit/4ceb8846b7307cf522d841c909d7eaf7fcb1aa4e), [`15e3e90`](https://github.com/DavideCarvalho/nestjs-telescope/commit/15e3e903d82616966342feeb966fbd44ad6a2631)]:
  - @dudousxd/nestjs-telescope@2.0.0

## 1.0.0

### Minor Changes

- [`d507547`](https://github.com/DavideCarvalho/nestjs-telescope/commit/d507547df3c13e76e90b8a97c4e3e1d8aef25bd1) - Add OpenTelemetry trace linking. The new `@dudousxd/nestjs-telescope-otel`
  package implements core's `TraceContextProvider` SPI by reading the active
  OpenTelemetry span via `@opentelemetry/api` (`OtelTraceContextProvider`,
  optional peer, read-only — never creates or exports spans, degrades to `null`
  when no span/API is present). Core gains the `TraceContextProvider` SPI,
  `traceId`/`spanId` on each `Entry`, and a `meta.traceLink` template so the UI
  can deep-link entries to a trace backend; the MikroORM storage provider adds the
  corresponding trace columns so the ids survive persistence. The Redis storage
  provider now reconstructs `traceId`/`spanId` when reading entries back, and the
  dashboard shows a Trace row in the entry detail with a clickable deep-link when
  `traceLink` is configured.

### Patch Changes

- Updated dependencies [[`73b50ad`](https://github.com/DavideCarvalho/nestjs-telescope/commit/73b50ad00193127271fdec36ad080d2858045922), [`9126bb0`](https://github.com/DavideCarvalho/nestjs-telescope/commit/9126bb04777cdaec6af3b0a1c5fe6f91d055ce82), [`1f00e62`](https://github.com/DavideCarvalho/nestjs-telescope/commit/1f00e62c8e60482b64251813680a5f866ef1619a), [`090cd1f`](https://github.com/DavideCarvalho/nestjs-telescope/commit/090cd1ff871dbe46c1c877a26f90496550b5304c), [`b7326b3`](https://github.com/DavideCarvalho/nestjs-telescope/commit/b7326b33d8d55b5f1ac5de4256f5e1980278699e), [`bfc0e26`](https://github.com/DavideCarvalho/nestjs-telescope/commit/bfc0e268388b5563d05c24e4de6ff99c74d1201a), [`7797a2a`](https://github.com/DavideCarvalho/nestjs-telescope/commit/7797a2a1554aff49bb59f5ca1b204974a7e04a41), [`6817fe6`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6817fe62775b1ff847fdb1038d3298e7709569e0), [`20ceb87`](https://github.com/DavideCarvalho/nestjs-telescope/commit/20ceb878cd4495dfbc7a3c71d882ae216a633757), [`1dd4db0`](https://github.com/DavideCarvalho/nestjs-telescope/commit/1dd4db0f3cd46d04b35ac112343cfb424c2d3190), [`a9f517c`](https://github.com/DavideCarvalho/nestjs-telescope/commit/a9f517c076461aef55cfb90d072ec38427ace91b), [`9d8eb65`](https://github.com/DavideCarvalho/nestjs-telescope/commit/9d8eb6562a7584801d5aa8b74491091f0fade5f9), [`418f1f0`](https://github.com/DavideCarvalho/nestjs-telescope/commit/418f1f0421948b40b25f845441a716fa4c6655c2), [`e76980d`](https://github.com/DavideCarvalho/nestjs-telescope/commit/e76980ddd7ee740f1b337a422a98ca98d97a007e), [`80c8f97`](https://github.com/DavideCarvalho/nestjs-telescope/commit/80c8f9769c8ab9ee724635086740910bc4d44ea3), [`e14ac60`](https://github.com/DavideCarvalho/nestjs-telescope/commit/e14ac603551372fc3767c63a349c509582b5e6ab), [`6fa0946`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6fa0946f5543868704864af2e32793eb448ac827), [`d507547`](https://github.com/DavideCarvalho/nestjs-telescope/commit/d507547df3c13e76e90b8a97c4e3e1d8aef25bd1), [`affd07e`](https://github.com/DavideCarvalho/nestjs-telescope/commit/affd07e4cb9ee85cfabaabed424833e8c638d04a), [`6a4d8d5`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6a4d8d56321d3840fe64e646130ccfdafcfb1bdd), [`c1f1ec9`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c1f1ec903d470d6b884924e2713de305b61b7481), [`cad6dae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/cad6dae0dba4f22e476d78c23ce2f74f7f6848e4), [`c8596c8`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c8596c85712880cb235e8cce059a1d93d339e9bd), [`c4222b1`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c4222b16ef4c0fc9c61694eb67033f03369ff24e), [`de29d2f`](https://github.com/DavideCarvalho/nestjs-telescope/commit/de29d2f519b1f25bc702c9dcc737d99b4751c8c9), [`10a3bc2`](https://github.com/DavideCarvalho/nestjs-telescope/commit/10a3bc224f6e0b1a237e1e7631acad70493b4c12), [`abde392`](https://github.com/DavideCarvalho/nestjs-telescope/commit/abde39264effb31b0524cc4fa89a335276c8dccb), [`8ff32a2`](https://github.com/DavideCarvalho/nestjs-telescope/commit/8ff32a2cc95775224eea3377460d91674dfda47f), [`5f2eddd`](https://github.com/DavideCarvalho/nestjs-telescope/commit/5f2eddd0ed5d72bf1de323b45870d7ddcaf64349), [`b14a201`](https://github.com/DavideCarvalho/nestjs-telescope/commit/b14a20175eae3d3017e8cbc068d367a03f634175), [`a90ef56`](https://github.com/DavideCarvalho/nestjs-telescope/commit/a90ef569ba12484bece07d8de2045e13ff2ff528), [`593bcc8`](https://github.com/DavideCarvalho/nestjs-telescope/commit/593bcc85ad6558040c62ba66bd1e5e0cbe5a6ac7), [`7b6636b`](https://github.com/DavideCarvalho/nestjs-telescope/commit/7b6636b54438427cd53ea0cbedd186b77d807169), [`e64f35a`](https://github.com/DavideCarvalho/nestjs-telescope/commit/e64f35a1bb7cae15b2ef24404888463d04f81eef), [`4892ef6`](https://github.com/DavideCarvalho/nestjs-telescope/commit/4892ef61e45e5486d34c7ec82764e6767fe8233d)]:
  - @dudousxd/nestjs-telescope@1.0.0
