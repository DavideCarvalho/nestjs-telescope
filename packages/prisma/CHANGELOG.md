# @dudousxd/nestjs-telescope-prisma

## 3.0.0

### Major Changes

- [#188](https://github.com/DavideCarvalho/nestjs-telescope/pull/188) [`1242fd8`](https://github.com/DavideCarvalho/nestjs-telescope/commit/1242fd889bcdb43037b08ec781f04de1fa1a7440) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Require Node.js 24 or newer: `engines.node` is now `>=24` (was `>=20`). CI tests on Node 24 and 26. `@dudousxd/nestjs-telescope` depends on `better-sqlite3` 12.11.1 (was 11.10.0, which neither ships a prebuild for nor compiles on Node 26).

  Removed, with no replacement alias (see the docs' Upgrading page):

  - `@dudousxd/nestjs-telescope`: the `alerts.webhookUrl` option. Use `alerts.channels: [webhookChannel(url)]`, which sends the same payload. `alerts.channels` is now required.
  - `@dudousxd/nestjs-telescope-ui`: `BarChartCard`'s `onBarClick` prop (use `onSelect`), and the `chartTheme`, `tooltipContentStyle`, `tooltipLabelStyle`, `tooltipItemStyle` and `axisTickStyle` exports (`ChartContainer` and `ChartTooltipContent` style the charts). `TelescopeMeta`'s `tracesEnabled`, `ai`, `entryTypes`, `dashboards` and `profiling` are now required, as the server always sends them.

## 2.1.0

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

## 2.0.2

### Patch Changes

- [#183](https://github.com/DavideCarvalho/nestjs-telescope/pull/183) [`1a1d056`](https://github.com/DavideCarvalho/nestjs-telescope/commit/1a1d0560b680349d4e1ce142a61910ddebcb9ae2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Works with `@dudousxd/nestjs-telescope` 3: the peer range is now `^2.0.1 || ^3.0.0`. Nothing else changes.

## 2.0.1

### Patch Changes

- [#179](https://github.com/DavideCarvalho/nestjs-telescope/pull/179) [`3f6437a`](https://github.com/DavideCarvalho/nestjs-telescope/commit/3f6437ae527264cc5acbbd4be7c0b9ab060cfdc9) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Republish the 2.0 release as 2.0.1. The 2.0.0 versions on npm are an old accidental build from 2026-06-05 (deprecated at the time), so `changeset publish` skipped them as "already published" and `^2.0.0` installs that June build. 2.0.1 is the real 2.0: the first-party NestJS integration and route protection release, with no further changes.

## 2.0.0

### Major Changes

- [#178](https://github.com/DavideCarvalho/nestjs-telescope/pull/178) [`3222eae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/3222eae574429a9807784ba413e8f0e43c3d98d3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Requires `@dudousxd/nestjs-telescope@2`: the `@dudousxd/nestjs-telescope` peer range moves from `^1` to `^2`. No API of this package changes. Core 2.0 protects the console's routes only with `decorators` / `routes: false` (`@nestjs/authentication` + `@nestjs/authorization`) and refuses to boot in production without them; queue mutations (bullmq, sqs) are switched on with `mutations: true` instead of `authorizeAction`. See core's changelog for the migration.

### Patch Changes

- Updated dependencies [[`3222eae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/3222eae574429a9807784ba413e8f0e43c3d98d3), [`3222eae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/3222eae574429a9807784ba413e8f0e43c3d98d3), [`3222eae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/3222eae574429a9807784ba413e8f0e43c3d98d3)]:
  - @dudousxd/nestjs-telescope@2.0.0

## 1.11.1

### Patch Changes

- [#174](https://github.com/DavideCarvalho/nestjs-telescope/pull/174) [`8a61f3d`](https://github.com/DavideCarvalho/nestjs-telescope/commit/8a61f3d41366b79a28caa1b211989614b890bcba) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Cheaper dashboard reads and flushes, and rollups that no longer lose counts across pods.

  - Per-type stats scan without entry content (cache stats excepted) and read only the content they show: one row per query or exception family, and request status codes from the `status:` tag.
  - Exception alerts are evaluated in their own queue behind the flush, so a slow channel, geo lookup or AI diagnosis no longer delays the next flush; each family is checked once per flush, and the per-family cooldown map is bounded.
  - `/health` reuses its capture-cost measurement for a minute.
  - The in-memory store keeps entries sorted and reads a page from the newest end instead of copying and sorting everything per page.
  - Redis: rollup reads are two pipelined round trips; content-less reads use a content-free copy of each entry (`m:<id>`, falling back to the full entry for data written before it); `{ type, familyHash }` queries page the family index; tags with no entries left are removed from the tag counts.
  - MikroORM: rollups are written with one native upsert per chunk (MySQL/MariaDB, PostgreSQL, SQLite) that merges counts, max and histogram in the database, so concurrent pods never lose or reject each other's increments.
  - Parquet: listing an hour with many files is linear in the file count.
  - Query and log watchers compute the family hash / serialize the log message only when the recorder keeps the entry.

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

- [`d6f5bf3`](https://github.com/DavideCarvalho/nestjs-telescope/commit/d6f5bf3773e6240d7eb32e7f6b45e846837a4e43) - Add the Prisma query watcher: captures every SQL statement (SQL + duration +
  params) via `prisma.$on('query')` for the query log and slow-query visibility.
  Note: Prisma emits query events detached from the caller's async context, so
  captured queries do NOT correlate to their request/job batch (and N+1 detection,
  which is per-batch, does not apply) — see the README caveat.

### Patch Changes

- Updated dependencies [[`73b50ad`](https://github.com/DavideCarvalho/nestjs-telescope/commit/73b50ad00193127271fdec36ad080d2858045922), [`9126bb0`](https://github.com/DavideCarvalho/nestjs-telescope/commit/9126bb04777cdaec6af3b0a1c5fe6f91d055ce82), [`1f00e62`](https://github.com/DavideCarvalho/nestjs-telescope/commit/1f00e62c8e60482b64251813680a5f866ef1619a), [`090cd1f`](https://github.com/DavideCarvalho/nestjs-telescope/commit/090cd1ff871dbe46c1c877a26f90496550b5304c), [`b7326b3`](https://github.com/DavideCarvalho/nestjs-telescope/commit/b7326b33d8d55b5f1ac5de4256f5e1980278699e), [`bfc0e26`](https://github.com/DavideCarvalho/nestjs-telescope/commit/bfc0e268388b5563d05c24e4de6ff99c74d1201a), [`7797a2a`](https://github.com/DavideCarvalho/nestjs-telescope/commit/7797a2a1554aff49bb59f5ca1b204974a7e04a41), [`6817fe6`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6817fe62775b1ff847fdb1038d3298e7709569e0), [`20ceb87`](https://github.com/DavideCarvalho/nestjs-telescope/commit/20ceb878cd4495dfbc7a3c71d882ae216a633757), [`1dd4db0`](https://github.com/DavideCarvalho/nestjs-telescope/commit/1dd4db0f3cd46d04b35ac112343cfb424c2d3190), [`a9f517c`](https://github.com/DavideCarvalho/nestjs-telescope/commit/a9f517c076461aef55cfb90d072ec38427ace91b), [`9d8eb65`](https://github.com/DavideCarvalho/nestjs-telescope/commit/9d8eb6562a7584801d5aa8b74491091f0fade5f9), [`418f1f0`](https://github.com/DavideCarvalho/nestjs-telescope/commit/418f1f0421948b40b25f845441a716fa4c6655c2), [`e76980d`](https://github.com/DavideCarvalho/nestjs-telescope/commit/e76980ddd7ee740f1b337a422a98ca98d97a007e), [`80c8f97`](https://github.com/DavideCarvalho/nestjs-telescope/commit/80c8f9769c8ab9ee724635086740910bc4d44ea3), [`e14ac60`](https://github.com/DavideCarvalho/nestjs-telescope/commit/e14ac603551372fc3767c63a349c509582b5e6ab), [`6fa0946`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6fa0946f5543868704864af2e32793eb448ac827), [`d507547`](https://github.com/DavideCarvalho/nestjs-telescope/commit/d507547df3c13e76e90b8a97c4e3e1d8aef25bd1), [`affd07e`](https://github.com/DavideCarvalho/nestjs-telescope/commit/affd07e4cb9ee85cfabaabed424833e8c638d04a), [`6a4d8d5`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6a4d8d56321d3840fe64e646130ccfdafcfb1bdd), [`c1f1ec9`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c1f1ec903d470d6b884924e2713de305b61b7481), [`cad6dae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/cad6dae0dba4f22e476d78c23ce2f74f7f6848e4), [`c8596c8`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c8596c85712880cb235e8cce059a1d93d339e9bd), [`c4222b1`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c4222b16ef4c0fc9c61694eb67033f03369ff24e), [`de29d2f`](https://github.com/DavideCarvalho/nestjs-telescope/commit/de29d2f519b1f25bc702c9dcc737d99b4751c8c9), [`10a3bc2`](https://github.com/DavideCarvalho/nestjs-telescope/commit/10a3bc224f6e0b1a237e1e7631acad70493b4c12), [`abde392`](https://github.com/DavideCarvalho/nestjs-telescope/commit/abde39264effb31b0524cc4fa89a335276c8dccb), [`8ff32a2`](https://github.com/DavideCarvalho/nestjs-telescope/commit/8ff32a2cc95775224eea3377460d91674dfda47f), [`5f2eddd`](https://github.com/DavideCarvalho/nestjs-telescope/commit/5f2eddd0ed5d72bf1de323b45870d7ddcaf64349), [`b14a201`](https://github.com/DavideCarvalho/nestjs-telescope/commit/b14a20175eae3d3017e8cbc068d367a03f634175), [`a90ef56`](https://github.com/DavideCarvalho/nestjs-telescope/commit/a90ef569ba12484bece07d8de2045e13ff2ff528), [`593bcc8`](https://github.com/DavideCarvalho/nestjs-telescope/commit/593bcc85ad6558040c62ba66bd1e5e0cbe5a6ac7), [`7b6636b`](https://github.com/DavideCarvalho/nestjs-telescope/commit/7b6636b54438427cd53ea0cbedd186b77d807169), [`e64f35a`](https://github.com/DavideCarvalho/nestjs-telescope/commit/e64f35a1bb7cae15b2ef24404888463d04f81eef), [`4892ef6`](https://github.com/DavideCarvalho/nestjs-telescope/commit/4892ef61e45e5486d34c7ec82764e6767fe8233d)]:
  - @dudousxd/nestjs-telescope@1.0.0
