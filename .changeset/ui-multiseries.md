---
'@dudousxd/nestjs-telescope-ui': minor
---

Richer dashboard charts: per-type stacked-bar throughput (with a legend) on the
Pulse page, and a per-queue throughput sparkline column on the Queues page (via
a `tag`-filtered timeseries). New `StackedBars` / `QueueSparkline` components +
`stackedBarLayout`/`deriveTypes`/`colorForType` helpers exported at `/react`;
`QueuesPanel` gains an optional `sparkline` render-prop.
