---
"@dudousxd/nestjs-telescope-otel": major
"@dudousxd/nestjs-telescope": minor
"@dudousxd/nestjs-telescope-ui": minor
"@dudousxd/nestjs-telescope-typeorm": minor
"@dudousxd/nestjs-telescope-mikro-orm": minor
"@dudousxd/nestjs-telescope-prisma": minor
"@dudousxd/nestjs-telescope-redis-watcher": minor
---

Telescope works with your app's OpenTelemetry SDK instead of running its own exporter.

- New `telescopeSpanProcessor(options?)` (`@dudousxd/nestjs-telescope-otel/span-processor`, also on the main entry): add it to `NodeSDK({ spanProcessors })` and your app's spans become `span` entries in the request's trace waterfall. Spans a watcher already records are skipped with the driver spans under them: the HTTP server span (request middleware), SQL driver spans while the TypeORM/MikroORM logger or the Prisma watcher is on, ioredis/redis spans while the redis watcher is on, and the HTTP client span (undici or `http`) of a `fetch` or axios call the http-client watcher records (axios requests now run inside the watcher's scope through their adapter; other http calls, like the AWS SDK's, still come through). When sampling can drop a covering watcher's entries, the processor holds the call's span and records it only when the entry was dropped, so sampled-out SQL still shows in the waterfall. Telescope's own spans and requests to the dashboard are skipped too. Options: `ignore`, `maxSpansPerTrace` (200), `maxAttributes` (64), `maxAttributeLength` (2048). The subpath loads no OpenTelemetry package and no Nest, so it can be imported in the SDK bootstrap file.
- Telescope's storage reads and writes run with OpenTelemetry tracing suppressed, so they no longer show up in the app's traces.
- `TelescopeOtelExporter` no longer re-exports `span` entries (they came from the SDK).
- core: new `span` entry type and `RecordInput.spanId`; the dashboard lists **Spans** when the processor is on.
- core: the trace waterfall nests entries that name a parent span (`content.parentSpanId`) under the entry with that `spanId`, and falls back to time containment for the rest.
- mikro-orm: `created_at` has millisecond precision (`datetime(3)` on MySQL/MariaDB), so the waterfall no longer collapses a trace onto whole seconds. With the default `ensureSchema`, the column is altered on the next boot (a table rebuild on MySQL). With `ensureSchema: false`, run `ALTER TABLE telescope_entries MODIFY created_at DATETIME(3) NOT NULL;`.

**Breaking (otel):**

- `TelescopeAiMetricsExporter` records on the global meter (`metrics.getMeter('telescope')`) and no longer runs a private OTLP `MeterProvider`. The `endpoint`, `path`, `headers`, `exportIntervalMs`, `timeoutMs` and `serviceName` options are removed and throw at boot: configure them on the SDK (`new NodeSDK({ serviceName, metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url, headers }), exportIntervalMillis })] })`). `flush()`, the second constructor argument and the `OtelMetricsSdk` type are removed; `{ meter }` passes a meter of your own.
- The `@opentelemetry/sdk-metrics`, `@opentelemetry/exporter-metrics-otlp-http` and `@opentelemetry/resources` optional peers are dropped.
