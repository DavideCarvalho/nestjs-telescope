---
"@dudousxd/nestjs-telescope": minor
"@dudousxd/nestjs-telescope-ui": minor
"@dudousxd/nestjs-telescope-ai": minor
"@dudousxd/nestjs-telescope-cache": minor
"@dudousxd/nestjs-telescope-logs": minor
"@dudousxd/nestjs-telescope-otel": minor
"@dudousxd/nestjs-telescope-schedule": minor
"@dudousxd/nestjs-telescope-bullmq": minor
"@dudousxd/nestjs-telescope-redis": minor
"@dudousxd/nestjs-telescope-sqs": minor
"@dudousxd/nestjs-telescope-typeorm": minor
"@dudousxd/nestjs-telescope-prisma": minor
"@dudousxd/nestjs-telescope-mikro-orm": minor
"@dudousxd/nestjs-telescope-redis-watcher": minor
"@dudousxd/nestjs-telescope-mikro-orm-watcher": minor
"@dudousxd/nestjs-telescope-events": minor
"@dudousxd/nestjs-telescope-mail": minor
"@dudousxd/nestjs-telescope-testing": minor
---

Ecosystem improvements across the telescope packages.

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
