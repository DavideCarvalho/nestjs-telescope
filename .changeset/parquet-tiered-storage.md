---
'@dudousxd/nestjs-telescope-parquet': minor
---

Add `@dudousxd/nestjs-telescope-parquet`: tiered storage — a hot `StorageProvider` plus a cold Parquet tier on S3 or a directory

`parquetColdStore()` writes `type=<type>/dt=<yyyy-mm-dd>/hour=<hh>/<instanceId>-<uuid>.parquet` files, sorted by `(created_at, id)` in 10,000-row groups with statistics and bloom filters, through the host's own AWS SDK v3 `S3Client` (ranged `GetObject` reads) or to a local directory. `cold.archive({ types })` plugs it into core's existing archive-then-delete pipeline as the sink, sized 5,000 × 20 per type per cycle. `tieredStorage({ hot, cold })` is one `StorageProvider` over both: writes, updates, leases and rollups stay hot; `get`, `find`, `batch`, traces, search and tags merge both tiers on the `(createdAt, id)` keyset, so the cursor and newest-first order are unchanged across the boundary and an entry briefly in both tiers is returned once. A cold failure degrades to hot results with core's `Page.partial` set, which the dashboard shows. Closed hours are compacted under the prune lease, and an optional `retention` deletes expired hours where bucket lifecycle rules are not used.

Reads use hyparquet by default — pure JavaScript, nothing native, nothing downloaded at runtime. `engine: { duckdb }` opts into `@duckdb/node-api` (an optional peer; boot fails clearly if it is missing), which never loads `httpfs`: it reads local copies of objects fetched through the same S3 client. Passes the shared storage conformance suite with a directory cold tier and a MinIO-backed S3 cold tier, on both engines.
