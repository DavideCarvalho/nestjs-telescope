---
'@dudousxd/nestjs-telescope': minor
---

Add a pre-aggregated rollup layer (Pulse-style ingest aggregation) and back the
timeseries endpoint with it. A new optional `RollupStore` SPI
(`recordRollups`/`queryRollups`, detected via `isRollupStore`) sits ALONGSIDE
`StorageProvider` — stores that do not implement it keep working unchanged via
the raw entry scan. On every successful flush the `Recorder` folds the drained
batch into 1-minute `(type, bucketStart)` rollups (count/sum/max, null durations
as 0) and records them best-effort; a rollup failure never affects the entry
store. `InMemoryStorageProvider` and `SqliteStorageProvider` implement the SPI
(sqlite via an additive `on conflict do update` upsert into `telescope_rollups`).
`TimeseriesService` reads rollups when available — re-bucketing the 1-minute
rollups into the requested report buckets and producing the SAME
`TimeseriesReport` shape as the raw scan — and transparently falls back to the
raw scan for tag-filtered queries and non-rollup stores.
