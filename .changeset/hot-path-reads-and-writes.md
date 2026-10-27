---
'@dudousxd/nestjs-telescope': patch
'@dudousxd/nestjs-telescope-redis': patch
'@dudousxd/nestjs-telescope-mikro-orm': patch
'@dudousxd/nestjs-telescope-parquet': patch
'@dudousxd/nestjs-telescope-typeorm': patch
'@dudousxd/nestjs-telescope-prisma': patch
'@dudousxd/nestjs-telescope-logs': patch
---

Cheaper dashboard reads and flushes, and rollups that no longer lose counts across pods.

- Per-type stats scan without entry content (cache stats excepted) and read only the content they show: one row per query or exception family, and request status codes from the `status:` tag.
- Exception alerts are evaluated in their own queue behind the flush, so a slow channel, geo lookup or AI diagnosis no longer delays the next flush; each family is checked once per flush, and the per-family cooldown map is bounded.
- `/health` reuses its capture-cost measurement for a minute.
- The in-memory store keeps entries sorted and reads a page from the newest end instead of copying and sorting everything per page.
- Redis: rollup reads are two pipelined round trips; content-less reads use a content-free copy of each entry (`m:<id>`, falling back to the full entry for data written before it); `{ type, familyHash }` queries page the family index; tags with no entries left are removed from the tag counts.
- MikroORM: rollups are written with one native upsert per chunk (MySQL/MariaDB, PostgreSQL, SQLite) that merges counts, max and histogram in the database, so concurrent pods never lose or reject each other's increments.
- Parquet: listing an hour with many files is linear in the file count.
- Query and log watchers compute the family hash / serialize the log message only when the recorder keeps the entry.
