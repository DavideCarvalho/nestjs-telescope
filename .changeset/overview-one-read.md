---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
'@dudousxd/nestjs-telescope-mikro-orm': minor
---

A faster Overview, above all on a control plane.

- `GET pulse` takes `cards=` (only those cards; the others come back empty and the reads they need are skipped) and `buckets=` (adds `timeseries`, the throughput over the window, from the read that counts it). `PulseService.getHealth(windowMs, { cards, buckets })`. The Overview makes one Pulse read with the cards it shows and its charts' 60 buckets, instead of a Pulse read plus a `GET timeseries` read of the same window.
- A console view of one app (`?app=` on a control plane) or one organization now runs Pulse and the timeseries as the store's `GROUP BY`s for that tag, instead of scanning at most 50,000 entries of the window. Before, a busy app's 24-hour Overview covered only its newest entries (`truncated`); now it covers the whole window. On a 2.4M-row PostgreSQL table, a 1-hour `?app=` Overview went from about 490 ms to about 30 ms, a 24-hour one from about 2.2 s (truncated) to about 1.1 s (complete).
- MikroORM: opt-in Overview indexes, `storage.createOverviewIndexes()` / `overviewIndexStatements(dialect)` (PostgreSQL builds them `CONCURRENTLY`, MySQL online), never at boot. The boot schema heal no longer drops indexes the entities do not declare, so they (and any index you added to `telescope_entries`) survive upgrades. On PostgreSQL 14+ the bucketed counts use `date_bin`.
