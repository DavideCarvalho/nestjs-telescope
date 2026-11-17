---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-mikro-orm': minor
'@dudousxd/nestjs-telescope-clickhouse': minor
'@dudousxd/nestjs-telescope-testing': minor
'@dudousxd/nestjs-telescope-parquet': patch
---

Scale: Pulse and the timeseries aggregate in the store, the App picker stops counting tags, and polling queries can be ignored.

- New optional storage method `aggregate(request)`: a few `GROUP BY`s (counts by type and time bucket, slowest entries, per-family stats with nearest-rank p50/p99, per-batch query families, per-user load). The SQLite, MikroORM (SQLite, MySQL/MariaDB, PostgreSQL) and ClickHouse stores implement it, so Pulse and the timeseries no longer page up to 50 000 entries into Node and are no longer truncated. Stores without it (Redis, in-memory, tiered, third-party), a tenant-scoped console view, or a store whose aggregation throws keep the scan, with the same results.
- `GET <path>/api/apps` lists the apps from an index fed by the ingest and reconciled every five minutes with the fleet's instance registry (`TelescopeKnownApps`), instead of counting the `app:` tags of the whole table on every request. Only without a registry (`fleet: false`), or while it is empty, does it count the `app:` tags of the newest 50 000 entries, through the new optional `TagQuery.recent` (SQLite and in-memory honour it; MikroORM caps its existing 10 000-row window with it; the tiered store reads the hot tier only). `tags()` without `recent` (the tag browser) is unchanged. A console scoped to organizations still reads them through its view.
- `ignoreQueries`: drop queries (polling and other noise) before they are recorded, by substring, RegExp or `(sql, content) => boolean`. The N+1 detector keeps working on the queries that are recorded.
- Testing: the conformance suite checks `aggregate` against the scan; `describeStorageAggregation` runs that part alone.
