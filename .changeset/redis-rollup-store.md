---
'@dudousxd/nestjs-telescope-redis': minor
---

`RedisStorageProvider` now implements the `RollupStore` SPI, so redis-backed
deployments get rollup-backed timeseries automatically (the Recorder's ingest
hook and the timeseries service both detect the provider via `isRollupStore`).
Each rollup is stored as a hash `r:<metric>:<bucketStart>` with additive
`count`/`sum` (HINCRBY) and a running `max`, plus a per-metric index ZSET
`rz:<metric>` (score = bucketStart) for range queries. `recordRollups`
accumulates per `(metric, bucketStart)` — count/sum via HINCRBY, max via
HGET+compare+HSET (no Lua, so it works on ioredis-mock; accepts a tiny race on
max under concurrent writers); `queryRollups` ZRANGEBYSCOREs each metric's index
over the inclusive bucket range and HGETALLs the hashes; `clear()` already
removes every prefixed key, so rollups are emptied too.
