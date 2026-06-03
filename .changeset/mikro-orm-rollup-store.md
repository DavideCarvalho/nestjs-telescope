---
'@dudousxd/nestjs-telescope-mikro-orm': minor
---

`MikroOrmStorageProvider` now implements the `RollupStore` SPI, so production
MySQL deployments get rollup-backed timeseries automatically (the Recorder's
ingest hook and the timeseries service both detect the provider via
`isRollupStore`). Adds a `TelescopeRollup` entity mapping the `telescope_rollups`
table (composite PK `(metric, bucket_start)` with additive `count`/`sum` and a
running `max`), registered in the provider's owned ORM so `schema.update({ safe:
true })` self-heals it additively at boot — no migration. `recordRollups`
accumulates per `(metric, bucketStart)` inside a transaction (read-modify-write,
portable across MySQL/SQLite); `queryRollups` filters by metric set and an
inclusive bucket range; `clear()` now also empties the rollups table.
