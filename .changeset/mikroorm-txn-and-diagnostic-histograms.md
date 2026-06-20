---
"@dudousxd/nestjs-telescope-mikro-orm-watcher": minor
"@dudousxd/nestjs-telescope-otel": minor
---

Capture MikroORM flush/transaction lifecycle and export duration histograms.

- `@dudousxd/nestjs-telescope-mikro-orm-watcher`: the model watcher now also records **flush** (`{ kind: 'flush' }`) and **transaction** (`{ kind: 'transaction', outcome }`) entries with a measured `durationMs`, in addition to entity create/update/delete (now tagged `{ kind: 'entity' }`). Timing is keyed per-EntityManager via a WeakMap, so concurrent flushes from different forked EMs never share a start slot.
- `@dudousxd/nestjs-telescope-otel`: `mapInput` now emits `telescope_mikroorm_flush_total` + `telescope_mikroorm_flush_duration_ms`, `telescope_mikroorm_transaction_total{outcome}` + `telescope_mikroorm_transaction_duration_ms`, and — when a `diagnostic` entry carries a `durationMs` — a `telescope_diagnostic_duration_ms{lib,event}` histogram alongside the existing `telescope_diagnostic_total` counter. This lets MikroORM flush/transaction timing and duration-bearing diagnostics events become Grafana-queryable `histogram_quantile` metrics.
