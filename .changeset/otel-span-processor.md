---
"@dudousxd/nestjs-telescope-otel": major
"@dudousxd/nestjs-telescope": minor
"@dudousxd/nestjs-telescope-ui": minor
"@dudousxd/nestjs-telescope-typeorm": minor
"@dudousxd/nestjs-telescope-mikro-orm": minor
"@dudousxd/nestjs-telescope-prisma": minor
"@dudousxd/nestjs-telescope-redis-watcher": minor
"@dudousxd/nestjs-telescope-bullmq": minor
"@dudousxd/nestjs-telescope-schedule": minor
"@dudousxd/nestjs-telescope-mail": minor
"@dudousxd/nestjs-telescope-mikro-orm-watcher": minor
"@dudousxd/nestjs-telescope-official": minor
"@dudousxd/nestjs-telescope-observe": minor
---

Telescope works with your app's OpenTelemetry SDK instead of running its own exporter.

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
