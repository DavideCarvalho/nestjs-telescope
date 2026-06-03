---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-schedule': patch
'@dudousxd/nestjs-telescope-mikro-orm': patch
'@dudousxd/nestjs-telescope-redis': patch
'@dudousxd/nestjs-telescope-ui': minor
---

Dashboard insights, charts, and trace grouping. Core gains a `StatsService` +
`GET /stats` endpoint with per-type analytics (latency p50/p95/p99, query-family
breakdown, cache hit/miss ratio, request status breakdown) and an `EntryQuery.traceId`
filter across all storages. The schedule watcher now tags scheduled runs with a stable
`schedule` tag. The dashboard adds a per-type insights header with Recharts cards, cache
hit/miss badges, a working Schedule view (job entries tagged `schedule`), and a
`#/traces/:traceId` page that groups every entry sharing an OpenTelemetry trace.
