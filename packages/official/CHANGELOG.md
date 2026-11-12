# @dudousxd/nestjs-telescope-official

## 0.3.0

### Minor Changes

- [#188](https://github.com/DavideCarvalho/nestjs-telescope/pull/188) [`1242fd8`](https://github.com/DavideCarvalho/nestjs-telescope/commit/1242fd889bcdb43037b08ec781f04de1fa1a7440) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Require Node.js 24 or newer: `engines.node` is now `>=24` (was `>=20`). CI tests on Node 24 and 26. `@dudousxd/nestjs-telescope` depends on `better-sqlite3` 12.11.1 (was 11.10.0, which neither ships a prebuild for nor compiles on Node 26).

  Removed, with no replacement alias (see the docs' Upgrading page):

  - `@dudousxd/nestjs-telescope`: the `alerts.webhookUrl` option. Use `alerts.channels: [webhookChannel(url)]`, which sends the same payload. `alerts.channels` is now required.
  - `@dudousxd/nestjs-telescope-ui`: `BarChartCard`'s `onBarClick` prop (use `onSelect`), and the `chartTheme`, `tooltipContentStyle`, `tooltipLabelStyle`, `tooltipItemStyle` and `axisTickStyle` exports (`ChartContainer` and `ChartTooltipContent` style the charts). `TelescopeMeta`'s `tracesEnabled`, `ai`, `entryTypes`, `dashboards` and `profiling` are now required, as the server always sends them.

## 0.2.0

### Minor Changes

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

## 0.1.1

### Patch Changes

- [#183](https://github.com/DavideCarvalho/nestjs-telescope/pull/183) [`1a1d056`](https://github.com/DavideCarvalho/nestjs-telescope/commit/1a1d0560b680349d4e1ce142a61910ddebcb9ae2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Works with `@dudousxd/nestjs-telescope` 3: the peer range is now `^2.0.1 || ^3.0.0`. Nothing else changes.

## 0.1.0

### Minor Changes

- [#178](https://github.com/DavideCarvalho/nestjs-telescope/pull/178) [`3222eae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/3222eae574429a9807784ba413e8f0e43c3d98d3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add `@dudousxd/nestjs-telescope-official`: Telescope for NestJS's first-party packages, with no runtime dependency on any of them (every payload is read structurally, so their 0.x churn degrades to fewer fields, never a crash).

  - **Official channels watchers** (`officialWatchers()`, or one by one): `NestResilienceWatcher` records `@nestjs/resilience`'s 9 `nestjs:resilience:*` channels (retries, timeouts, breaker transitions and refusals, bulkhead and rate-limit refusals, fallbacks) as `resilience` entries; `NestWorkflowsWatcher` records `@nestjs/workflows`' 19 `nestjs:workflows:*` lifecycle events as `workflow` entries; `NestAuthWatcher` records `@nestjs/authentication`'s 13 audit events and `@nestjs/authorization`'s `nestjs:authorization:denied` as `auth` entries; `NestMailWatcher` records `nestjs:mail:sent` / `nestjs:mail:failed` as Telescope's built-in `mail` entries. The payloads carry no trace id: the subscriber runs in the publisher's async context, so each entry joins the request/job batch and the current trace. Auth entries are redacted: only known fields are copied, session and refresh-token-family ids become a SHA-256 fingerprint (`sessionRef`, `tokenFamilyRef`), emails are masked, session `metadata` keeps its key names only, and a denial keeps the user's id and the argument count, never the user object or the records. Refusals and security signals are tagged `failed`.
  - **`telescopeAiUsage()`**: an `onUsage` listener for `@nestjs/ai` (`AiModule.forRoot({ onUsage: telescopeAiUsage() })` or a call's `onUsage`). Each model call becomes a `usage.recorded` `agent` entry in the shape the AI screen already reads (feature = the call's `label`, cached input as `cacheReadTokens`, cost as `costSource: 'estimate'`), and is counted by the AI metrics (`aiMetrics.prometheus`, the otel AI exporter). Options: `feature`, `actor`, `toUsd`, `record`, `metrics`.
  - **`ObserveTraceContextProvider`**: Telescope's `traceContext` from `@nestjs/observe`'s `TracerService.currentTraceId()` (the UUID as 32 hex digits, a non-hex `x-request-id` hashed, a synthetic span id), so one request carries the same id in Telescope and in NestJS Observe. It reads the trace id only: Telescope never ingests Observe's spans, metrics or any other telemetry.

  The channel lists are kept in this package for now; they can come from `@dudousxd/nestjs-diagnostics` once its official-channel constants are published.
