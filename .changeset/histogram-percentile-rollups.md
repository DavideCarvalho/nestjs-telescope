---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-mikro-orm': minor
'@dudousxd/nestjs-telescope-redis': minor
---

Estimate latency percentiles (p50/p95/p99 in `/stats`) from a pre-aggregated
latency histogram instead of scanning every raw entry in the window. Rollups now
carry a fixed-size `histogram` (counts per `LATENCY_BOUNDARIES_MS` cell, plus an
overflow cell) aggregated at flush time from `durationMs`. When the store is a
`RollupStore`, `StatsService` queries the histogram rollups for the type+window,
merges them element-wise, and calls `estimatePercentileFromHistogram`
(bucket-resolution nearest-rank, O(buckets)); count/max/slow and the
family/cache/status/exception breakdowns still derive from the raw scan, and
stores without rollup support keep the exact raw-scan percentile path as a
fallback.

The histogram is persisted and merged additively by every `RollupStore`
implementation (in-memory, core SQLite, MikroORM, Redis). Legacy rollup
rows/hashes without a histogram are self-healed (new column/field) and read back
as an all-zeros array of the canonical length — never NaN, never a crash.
