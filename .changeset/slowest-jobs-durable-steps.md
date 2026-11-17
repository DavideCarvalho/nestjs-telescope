---
"@dudousxd/nestjs-telescope": minor
"@dudousxd/nestjs-telescope-ui": minor
"@dudousxd/nestjs-telescope-mikro-orm": minor
"@dudousxd/nestjs-telescope-clickhouse": minor
"@dudousxd/nestjs-telescope-testing": minor
---

"Slowest jobs" shows durable workflow steps, and its empty state tells the truth.

- Pulse has a new `slowWork` list (with the `slowJobs` card): the slowest background work of the window by p95, with max, executions and failures, merging queue jobs (`job` entries, by family) and `@dudousxd/nestjs-durable` steps (`durable` entries whose family is `durable:step:<name>`, recorded by `@dudousxd/nestjs-durable-telescope` 0.13.0 and later), each labelled with its source. A failure is an entry tagged `failed`. `slowJobs` is unchanged.
- The `families` aggregation takes an optional `countTag`, and each row then says how many of its entries carry it (`tagged`), so the failures come from the same `GROUP BY` (and a console view of one app keeps its store aggregation). SQLite, MikroORM (SQLite, PostgreSQL, MySQL), ClickHouse and the federated store implement it; the storage conformance suite checks it.
- The Overview's "Slowest jobs" card lists both. With nothing to list it says "Not measured" only when neither `durable` nor a `job` watcher is on, and names both ways to turn one on; when durable is reporting it says no workflow step finished in the window, or that step timings need `@dudousxd/nestjs-durable-telescope` 0.13.0 when the window holds durable entries but no timed step.
- `registerTenantWatchers()` / `getTenantWatchers()`: a control plane can name watchers it runs for its tenants (durable's watcher adds `durable`), and `GET meta` counts them on for every app in view.
