# @dudousxd/nestjs-telescope-parquet

## 0.1.1

### Patch Changes

- [#174](https://github.com/DavideCarvalho/nestjs-telescope/pull/174) [`8a61f3d`](https://github.com/DavideCarvalho/nestjs-telescope/commit/8a61f3d41366b79a28caa1b211989614b890bcba) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Cheaper dashboard reads and flushes, and rollups that no longer lose counts across pods.

  - Per-type stats scan without entry content (cache stats excepted) and read only the content they show: one row per query or exception family, and request status codes from the `status:` tag.
  - Exception alerts are evaluated in their own queue behind the flush, so a slow channel, geo lookup or AI diagnosis no longer delays the next flush; each family is checked once per flush, and the per-family cooldown map is bounded.
  - `/health` reuses its capture-cost measurement for a minute.
  - The in-memory store keeps entries sorted and reads a page from the newest end instead of copying and sorting everything per page.
  - Redis: rollup reads are two pipelined round trips; content-less reads use a content-free copy of each entry (`m:<id>`, falling back to the full entry for data written before it); `{ type, familyHash }` queries page the family index; tags with no entries left are removed from the tag counts.
  - MikroORM: rollups are written with one native upsert per chunk (MySQL/MariaDB, PostgreSQL, SQLite) that merges counts, max and histogram in the database, so concurrent pods never lose or reject each other's increments.
  - Parquet: listing an hour with many files is linear in the file count.
  - Query and log watchers compute the family hash / serialize the log message only when the recorder keeps the entry.

## 0.1.0

### Minor Changes

- [#165](https://github.com/DavideCarvalho/nestjs-telescope/pull/165) [`6a1ecea`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6a1ecea013ea550167c362b69fcc74f27ec1c749) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add `@dudousxd/nestjs-telescope-parquet`: tiered storage — a hot `StorageProvider` plus a cold Parquet tier on S3 or a directory

  `parquetColdStore()` writes `type=<type>/dt=<yyyy-mm-dd>/hour=<hh>/<instanceId>-<uuid>.parquet` files, sorted by `(created_at, id)` in 10,000-row groups with statistics and bloom filters, through the host's own AWS SDK v3 `S3Client` (ranged `GetObject` reads) or to a local directory. `cold.archive({ types })` plugs it into core's existing archive-then-delete pipeline as the sink, sized 5,000 × 20 per type per cycle. `tieredStorage({ hot, cold })` is one `StorageProvider` over both: writes, updates, leases and rollups stay hot; `get`, `find`, `batch`, traces, search and tags merge both tiers on the `(createdAt, id)` keyset, so the cursor and newest-first order are unchanged across the boundary and an entry briefly in both tiers is returned once. A cold failure degrades to hot results with core's `Page.partial` set, which the dashboard shows. Closed hours are compacted under the prune lease, and an optional `retention` deletes expired hours where bucket lifecycle rules are not used.

  Reads use hyparquet by default — pure JavaScript, nothing native, nothing downloaded at runtime. `engine: { duckdb }` opts into `@duckdb/node-api` (an optional peer; boot fails clearly if it is missing), which never loads `httpfs`: it reads local copies of objects fetched through the same S3 client. Passes the shared storage conformance suite with a directory cold tier and a MinIO-backed S3 cold tier, on both engines.
