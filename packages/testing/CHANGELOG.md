# @dudousxd/nestjs-telescope-testing

## 1.12.0

### Minor Changes

- [#86](https://github.com/DavideCarvalho/nestjs-telescope/pull/86) [`0f27572`](https://github.com/DavideCarvalho/nestjs-telescope/commit/0f27572c68e66e10b8f8aefabf4c2cf7f8c77f2f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Let a throw outside the Nest pipeline become a real `exception` entry.

  An `exception` entry had exactly one door: `TelescopeExceptionInterceptor`, a `NestInterceptor`. An
  interceptor runs on the Nest execution pipeline and nowhere else, so a BullMQ job body, a `@Cron`
  callback, a durable workflow step, an `@OnEvent` listener — every unit of work that a watcher already
  gives a batch — could throw and produce no exception at all. The failure survived as a
  `failureReason` string on that unit's own `job` entry: no family, so no `new-exception` alert, no AI
  diagnosis, and nothing in the exceptions view. A nightly cron that had been throwing for a week was
  visible only to whoever happened to open that one entry.

  The fix is not "let each watcher build an exception entry too". Three things have to stay identical
  across every door or the dashboard splits into parallel realities — the family hash, the 4xx
  control-flow policy, and the entry shape — so the decision and the record were extracted into one
  place that the interceptor, the service and every watcher call into.

  - **`exception-capture.ts`** (new, exported) holds `isExpectedHttpControlFlow`,
    `toExceptionRecordInput` and `captureException`. The interceptor now delegates to it and keeps its
    behaviour byte-for-byte; an e2e over a real HTTP app pins the family hash, the 403 skip and the
    `captureHttp4xx` escape hatch so the extraction cannot drift.
  - **`WatcherContext.recordException(error, details?)`** is the watcher-facing door, backed by the new
    `TelescopeService.recordException`. It records into whatever batch is active, so the exception
    correlates to the job or run it came from — one trace, not two. `details` carries the `context` and
    `tags` a watcher knows and a stack does not (which queue, which job id, which task), because off
    the request path there is no sibling `request` entry to read that from.
  - **The 4xx skip now covers every door.** Hosts re-use `NotFoundException` in services that both a
    controller and a worker call; without this a retrying queue could open a new family, page on-call
    and burn a diagnosis through the back door the front door was hardened against after exactly that
    incident.
  - **`TelescopeCrashCapture`** (the process-level `unhandledRejection`/`uncaughtException` hook) now
    builds its entry with the shared `toExceptionRecordInput` instead of its own copy, so a crash and a
    route throw of the same error stay one family by construction rather than by two functions agreeing.
    It deliberately does NOT go through the 4xx skip: a 4xx is expected control flow only while
    something is handling it, and a `NotFoundException` that reached `unhandledRejection` is a bug
    whatever its status says.
  - **BullMQ and schedule watchers** hand their caught error over before re-throwing it. Recording can
    never change the host's control flow: the original error still propagates untouched, and a failure
    inside the capture path is swallowed and logged (the `safeRecord` precedent), guarded both by
    `captureException` and by the watchers' own try/catch.

  Additive: `recordException` is declared optional on `WatcherContext` so hand-rolled contexts — the
  fixtures every watcher package keeps in its specs — still type-check against the new core. Core
  always supplies it. Out-of-repo watchers (`@dudousxd/nestjs-durable-telescope` and friends) opt in
  with a single `ctx.recordException?.(error, { context })` in the catch block they already have.

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

### Patch Changes

- Updated dependencies [[`73b50ad`](https://github.com/DavideCarvalho/nestjs-telescope/commit/73b50ad00193127271fdec36ad080d2858045922), [`9126bb0`](https://github.com/DavideCarvalho/nestjs-telescope/commit/9126bb04777cdaec6af3b0a1c5fe6f91d055ce82), [`1f00e62`](https://github.com/DavideCarvalho/nestjs-telescope/commit/1f00e62c8e60482b64251813680a5f866ef1619a), [`090cd1f`](https://github.com/DavideCarvalho/nestjs-telescope/commit/090cd1ff871dbe46c1c877a26f90496550b5304c), [`b7326b3`](https://github.com/DavideCarvalho/nestjs-telescope/commit/b7326b33d8d55b5f1ac5de4256f5e1980278699e), [`bfc0e26`](https://github.com/DavideCarvalho/nestjs-telescope/commit/bfc0e268388b5563d05c24e4de6ff99c74d1201a), [`7797a2a`](https://github.com/DavideCarvalho/nestjs-telescope/commit/7797a2a1554aff49bb59f5ca1b204974a7e04a41), [`6817fe6`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6817fe62775b1ff847fdb1038d3298e7709569e0), [`20ceb87`](https://github.com/DavideCarvalho/nestjs-telescope/commit/20ceb878cd4495dfbc7a3c71d882ae216a633757), [`1dd4db0`](https://github.com/DavideCarvalho/nestjs-telescope/commit/1dd4db0f3cd46d04b35ac112343cfb424c2d3190), [`a9f517c`](https://github.com/DavideCarvalho/nestjs-telescope/commit/a9f517c076461aef55cfb90d072ec38427ace91b), [`9d8eb65`](https://github.com/DavideCarvalho/nestjs-telescope/commit/9d8eb6562a7584801d5aa8b74491091f0fade5f9), [`418f1f0`](https://github.com/DavideCarvalho/nestjs-telescope/commit/418f1f0421948b40b25f845441a716fa4c6655c2), [`e76980d`](https://github.com/DavideCarvalho/nestjs-telescope/commit/e76980ddd7ee740f1b337a422a98ca98d97a007e), [`80c8f97`](https://github.com/DavideCarvalho/nestjs-telescope/commit/80c8f9769c8ab9ee724635086740910bc4d44ea3), [`e14ac60`](https://github.com/DavideCarvalho/nestjs-telescope/commit/e14ac603551372fc3767c63a349c509582b5e6ab), [`6fa0946`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6fa0946f5543868704864af2e32793eb448ac827), [`d507547`](https://github.com/DavideCarvalho/nestjs-telescope/commit/d507547df3c13e76e90b8a97c4e3e1d8aef25bd1), [`affd07e`](https://github.com/DavideCarvalho/nestjs-telescope/commit/affd07e4cb9ee85cfabaabed424833e8c638d04a), [`6a4d8d5`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6a4d8d56321d3840fe64e646130ccfdafcfb1bdd), [`c1f1ec9`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c1f1ec903d470d6b884924e2713de305b61b7481), [`cad6dae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/cad6dae0dba4f22e476d78c23ce2f74f7f6848e4), [`c8596c8`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c8596c85712880cb235e8cce059a1d93d339e9bd), [`c4222b1`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c4222b16ef4c0fc9c61694eb67033f03369ff24e), [`de29d2f`](https://github.com/DavideCarvalho/nestjs-telescope/commit/de29d2f519b1f25bc702c9dcc737d99b4751c8c9), [`10a3bc2`](https://github.com/DavideCarvalho/nestjs-telescope/commit/10a3bc224f6e0b1a237e1e7631acad70493b4c12), [`abde392`](https://github.com/DavideCarvalho/nestjs-telescope/commit/abde39264effb31b0524cc4fa89a335276c8dccb), [`8ff32a2`](https://github.com/DavideCarvalho/nestjs-telescope/commit/8ff32a2cc95775224eea3377460d91674dfda47f), [`5f2eddd`](https://github.com/DavideCarvalho/nestjs-telescope/commit/5f2eddd0ed5d72bf1de323b45870d7ddcaf64349), [`b14a201`](https://github.com/DavideCarvalho/nestjs-telescope/commit/b14a20175eae3d3017e8cbc068d367a03f634175), [`a90ef56`](https://github.com/DavideCarvalho/nestjs-telescope/commit/a90ef569ba12484bece07d8de2045e13ff2ff528), [`593bcc8`](https://github.com/DavideCarvalho/nestjs-telescope/commit/593bcc85ad6558040c62ba66bd1e5e0cbe5a6ac7), [`7b6636b`](https://github.com/DavideCarvalho/nestjs-telescope/commit/7b6636b54438427cd53ea0cbedd186b77d807169), [`e64f35a`](https://github.com/DavideCarvalho/nestjs-telescope/commit/e64f35a1bb7cae15b2ef24404888463d04f81eef), [`4892ef6`](https://github.com/DavideCarvalho/nestjs-telescope/commit/4892ef61e45e5486d34c7ec82764e6767fe8233d)]:
  - @dudousxd/nestjs-telescope@1.0.0
