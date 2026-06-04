---
"@dudousxd/nestjs-telescope": minor
---

Add Recorder self-metrics + `GET /telescope/api/health`: surface Telescope's own
overhead — buffered count, ring high-water, flush count/durations, drop buckets,
and an on-demand `captureCostNanos` micro-benchmark of the synchronous capture
path. Hot-path-safe: `record()` only does integer counter bumps; the per-capture
cost figure comes from a separate benchmark, never from timing live records.
