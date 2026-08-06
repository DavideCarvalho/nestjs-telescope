---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-mikro-orm': minor
'@dudousxd/nestjs-telescope-redis': minor
---

Prune in bounded batches, and let a fleet prune once instead of once per pod.

**Why `minor` and not `patch`:** this adds public API — `pruneScopedBatch`,
`tryAcquireLease`/`releaseLease` on the storage contract, the `TelescopePruneLock`
seam, and five `prune.*` options. **Why not `major`:** nothing existing breaks.
Every new SPI method is optional, so a third-party provider compiles and runs
unchanged (it just keeps the old unbounded delete and logs a one-time warning),
and every new option is defaulted. The MikroORM adapter does add a
`telescope_leases` table, created by the same additive, never-dropping
`schema.update` that already manages `telescope_entries` — no migration to write,
nothing dropped, and it is in `telescopeManagedTables()` so a host's own migration
differ still skips it.

**Bounded batched deletes.** The retention delete was one unbounded
`DELETE ... WHERE created_at < ? AND type NOT IN (...)`. On a large table that
predicate matches nearly every row, so the planner correctly picks a full scan —
and that single statement holds row locks for the length of the scan. Measured on
a shared MySQL store: 755,614 rows / 1.3 GB, **21 concurrent prune deletes, the
oldest 63 minutes in**, with everything else writing to that database queued
behind them, and the pruner still 25h44m behind its own 24h window. The pruner now
issues a loop of short, individually-committed deletes, oldest first, tuned by
`prune.batchSize` (1000), `prune.maxBatchesPerCycle` (50) and `prune.batchPauseMs`
(50). Same rows deleted; locks released between batches. The ceiling matters as
much as the batching: without it a badly-behind table turns one tick into an
hour-long loop, which is the original failure spelled differently.

This is expressed portably. `DELETE ... ORDER BY ... LIMIT` is MySQL/MariaDB-only —
PostgreSQL has no `ORDER BY`/`LIMIT` on `DELETE`, SQLite needs a non-default
compile flag, SQL Server spells it `DELETE TOP (n)` — so the bound is "select the
oldest `limit` ids, then delete by primary key", which every driver renders, and
which is the better plan anyway (the `created_at` index walk stops after `limit`
matches and takes no row locks). `keepLast` scopes keep the unbounded path:
"keep the newest N of the doomed rows" is a whole-set property a per-batch bound
cannot express, so `keepLast` is absent from `BoundedPruneScope` by construction.

**A prune lock, so N replicas do not do the same work N times.** The in-flight
guard bounds one process; it cannot see the other seven pods. `prune.lock` adds a
small advisory seam — acquire a named lease with a TTL, release it, or be told
somebody else holds it — defaulting to a lease row in the database Telescope
already writes to, so it needs no new dependency and works on every in-repo
provider. A host that already runs a better primitive (a job engine's singleton
mutex, a Redis lock) supplies its own `TelescopePruneLock`; the acquire result is a
discriminated union, so an implementation cannot reach the lease without handling
the refusal. The lock is advisory by design — two concurrent prunes delete the same
rows and one wins, costing waste and never correctness — so the pruner **fails
open**: a broken lock warns once and prunes anyway rather than letting retention
silently stop while the table grows.
