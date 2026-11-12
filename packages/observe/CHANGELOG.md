# @dudousxd/nestjs-telescope-observe

## 1.1.0

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

## 1.0.0

### Patch Changes

- [#178](https://github.com/DavideCarvalho/nestjs-telescope/pull/178) [`3222eae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/3222eae574429a9807784ba413e8f0e43c3d98d3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **Deprecated.** This package is no longer built or released (it is now `private` in the workspace); `0.1.0` is its last published version. It forwarded Telescope entries to NestJS Observe over Observe's private, undocumented and unversioned ingest wire, transcribed from the encoders in github.com/nestjs/observe, and `@nestjs/observe` after 0.3.20 is under the NestJS Observe Agent License, which only lets that telemetry go to observe.nestjs.com and forbids using the software (its source included) to build a service that receives such telemetry or substitutes for theirs. Use `@nestjs/observe` itself to report into NestJS Observe, keep Telescope for the local console, and use `ObserveTraceContextProvider` from `@dudousxd/nestjs-telescope-official` to give both the same trace id.

- Updated dependencies [[`3222eae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/3222eae574429a9807784ba413e8f0e43c3d98d3), [`3222eae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/3222eae574429a9807784ba413e8f0e43c3d98d3), [`3222eae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/3222eae574429a9807784ba413e8f0e43c3d98d3)]:
  - @dudousxd/nestjs-telescope@2.0.0

## 0.1.0

### Minor Changes

- [#90](https://github.com/DavideCarvalho/nestjs-telescope/pull/90) [`63d5650`](https://github.com/DavideCarvalho/nestjs-telescope/commit/63d5650da3333dac9f09ed8ac26ece4005e08471) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add `@dudousxd/nestjs-telescope-observe`: a Telescope extension that forwards entries to NestJS Observe.

  Telescope batches are reassembled into Observe's snapshot/span model — a request becomes a snapshot, the queries, cache operations, Redis commands and outbound HTTP calls it caused become child spans positioned by their offset into it, and queue and schedule runs become job snapshots. Section-level `include` flags, per-batch sampling that never drops a failure, and a host `filter` control what leaves the process; the transport gzips, retries what can succeed later, and trips a breaker on bad credentials.

  Also fills the two sections Observe's dashboard leaves empty without them: a `runtime` snapshot (CPU, memory, GC by kind, event-loop lag and utilization) behind its Profiler, and `telescope.entries` / `telescope.duration_ms` custom metrics counted through the pre-sampling `observeRecord` hook, so they report what the process did rather than what survived sampling. Both were verified against the live collector, which answers 500 to a partial `runtime` — so an incomplete snapshot is withheld and retried rather than sent.
