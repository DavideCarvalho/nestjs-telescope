# @dudousxd/nestjs-telescope-parquet

## 2.0.1

### Patch Changes

- [#196](https://github.com/DavideCarvalho/nestjs-telescope/pull/196) [`afa6a43`](https://github.com/DavideCarvalho/nestjs-telescope/commit/afa6a43a90020308a9e20ff611b81333e3b2c17e) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Accept `@dudousxd/nestjs-telescope` 5: the peer range adds `^5.0.0` (otel's becomes `^4.2.0 || ^5.0.0`, published as written rather than through `workspace:^`). Nothing else changes; the bullmq and sqs READMEs document the live jobs route's new `filter[state]` / `after` / `first` wire.

## 2.0.0

### Major Changes

- [#188](https://github.com/DavideCarvalho/nestjs-telescope/pull/188) [`1242fd8`](https://github.com/DavideCarvalho/nestjs-telescope/commit/1242fd889bcdb43037b08ec781f04de1fa1a7440) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Require Node.js 24 or newer: `engines.node` is now `>=24` (was `>=20`). CI tests on Node 24 and 26. `@dudousxd/nestjs-telescope` depends on `better-sqlite3` 12.11.1 (was 11.10.0, which neither ships a prebuild for nor compiles on Node 26).

  Removed, with no replacement alias (see the docs' Upgrading page):

  - `@dudousxd/nestjs-telescope`: the `alerts.webhookUrl` option. Use `alerts.channels: [webhookChannel(url)]`, which sends the same payload. `alerts.channels` is now required.
  - `@dudousxd/nestjs-telescope-ui`: `BarChartCard`'s `onBarClick` prop (use `onSelect`), and the `chartTheme`, `tooltipContentStyle`, `tooltipLabelStyle`, `tooltipItemStyle` and `axisTickStyle` exports (`ChartContainer` and `ChartTooltipContent` style the charts). `TelescopeMeta`'s `tracesEnabled`, `ai`, `entryTypes`, `dashboards` and `profiling` are now required, as the server always sends them.

## 1.0.1

### Patch Changes

- [#183](https://github.com/DavideCarvalho/nestjs-telescope/pull/183) [`1a1d056`](https://github.com/DavideCarvalho/nestjs-telescope/commit/1a1d0560b680349d4e1ce142a61910ddebcb9ae2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Works with `@dudousxd/nestjs-telescope` 3: the peer range is now `^2.0.1 || ^3.0.0`. Nothing else changes.

## 1.0.0

### Patch Changes

- Updated dependencies [[`3222eae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/3222eae574429a9807784ba413e8f0e43c3d98d3), [`3222eae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/3222eae574429a9807784ba413e8f0e43c3d98d3), [`3222eae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/3222eae574429a9807784ba413e8f0e43c3d98d3)]:
  - @dudousxd/nestjs-telescope@2.0.0

## 0.1.2

### Patch Changes

- [#176](https://github.com/DavideCarvalho/nestjs-telescope/pull/176) [`abcf7e7`](https://github.com/DavideCarvalho/nestjs-telescope/commit/abcf7e73acbf7483b0db620f1e52686dd05648d0) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Removing cold files now works on MinIO versions that reject `DeleteObjects` with `MissingContentMD5`: it falls back to single deletes and remembers.

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
