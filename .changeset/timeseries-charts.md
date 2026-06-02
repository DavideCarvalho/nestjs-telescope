---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
---

Add throughput time-series. `GET /telescope/api/timeseries?window=1h&buckets=60`
returns bucketed entry counts (total + per type) computed from stored entries
(`TimeseriesService` + `bucketTimeseries`), with optional `type`/`tag` filters.
The dashboard renders it as a zero-dependency SVG `Sparkline` on the Pulse page
(also exported at `/react`).
