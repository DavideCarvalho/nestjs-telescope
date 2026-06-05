# @dudousxd/nestjs-telescope-mikro-orm

## 1.1.0

### Patch Changes

- Updated dependencies [[`c2423f3`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c2423f330be3f9b92c0dbf2348220bf8740dab86), [`d8173d4`](https://github.com/DavideCarvalho/nestjs-telescope/commit/d8173d4c5d362814aa0fcdb0bfb35fd353b3d1a8), [`d200d15`](https://github.com/DavideCarvalho/nestjs-telescope/commit/d200d158f927e6a67396e594b32bfd0a0b3424e4), [`953ae12`](https://github.com/DavideCarvalho/nestjs-telescope/commit/953ae12fd35e42df3b806d6bbec6b49e3e3c71fb), [`4ceb884`](https://github.com/DavideCarvalho/nestjs-telescope/commit/4ceb8846b7307cf522d841c909d7eaf7fcb1aa4e), [`15e3e90`](https://github.com/DavideCarvalho/nestjs-telescope/commit/15e3e903d82616966342feeb966fbd44ad6a2631)]:
  - @dudousxd/nestjs-telescope@2.0.0

## 1.0.0

### Minor Changes

- [`1dd4db0`](https://github.com/DavideCarvalho/nestjs-telescope/commit/1dd4db0f3cd46d04b35ac112343cfb424c2d3190) - Estimate latency percentiles (p50/p95/p99 in `/stats`) from a pre-aggregated
  latency histogram instead of scanning every raw entry in the window. Rollups now
  carry a fixed-size `histogram` (counts per `LATENCY_BOUNDARIES_MS` cell, plus an
  overflow cell) aggregated at flush time from `durationMs`. When the store is a
  `RollupStore`, `StatsService` queries the histogram rollups for the type+window,
  merges them element-wise, and calls `estimatePercentileFromHistogram`
  (bucket-resolution nearest-rank, O(buckets)); count/max/slow and the
  family/cache/status/exception breakdowns still derive from the raw scan, and
  stores without rollup support keep the exact raw-scan percentile path as a
  fallback.

  The histogram is persisted and merged additively by every `RollupStore`
  implementation (in-memory, core SQLite, MikroORM, Redis). Legacy rollup
  rows/hashes without a histogram are self-healed (new column/field) and read back
  as an all-zeros array of the canonical length — never NaN, never a crash.

- [`00e0539`](https://github.com/DavideCarvalho/nestjs-telescope/commit/00e05393b00047258622be093d0006af1999d300) - `MikroOrmStorageProvider` now implements the `RollupStore` SPI, so production
  MySQL deployments get rollup-backed timeseries automatically (the Recorder's
  ingest hook and the timeseries service both detect the provider via
  `isRollupStore`). Adds a `TelescopeRollup` entity mapping the `telescope_rollups`
  table (composite PK `(metric, bucket_start)` with additive `count`/`sum` and a
  running `max`), registered in the provider's owned ORM so `schema.update({ safe:
true })` self-heals it additively at boot — no migration. `recordRollups`
  accumulates per `(metric, bucketStart)` inside a transaction (read-modify-write,
  portable across MySQL/SQLite); `queryRollups` filters by metric set and an
  inclusive bucket range; `clear()` now also empties the rollups table.

- [`e14ac60`](https://github.com/DavideCarvalho/nestjs-telescope/commit/e14ac603551372fc3767c63a349c509582b5e6ab) - Add `MikroOrmStorageProvider`: persist Telescope entries to MySQL/SQLite through
  MikroORM with zero migration and zero manual table setup.

  The provider owns a **dedicated MikroORM scoped to a single `TelescopeEntry`** and
  **self-heals its schema at boot** (`schema.ensureDatabase()` +
  `schema.update({ safe: true })` — additive only: creates the table and adds
  missing columns, never drops). The scoped connection means the schema diff is
  structurally incapable of touching the host's other tables, and it avoids a
  self-capture loop with the query watcher's `loggerFactory`. Pass your existing
  `MikroORM` (its connection config is borrowed) or explicit connection options to
  run Telescope on a separate database. `ensureSchema: false` opts out.

  Core gains an optional `StorageProvider.init()` boot hook (awaited by
  `TelescopeModule` at startup) and now always calls `close()` after the final
  flush at shutdown — providers that borrow a host-owned resource must no-op
  `close()`. Features newest-first keyset pagination via an `$or` `(createdAt, id)`
  position and cross-driver tag filtering against a space-padded `tagsText` column.

- [`d507547`](https://github.com/DavideCarvalho/nestjs-telescope/commit/d507547df3c13e76e90b8a97c4e3e1d8aef25bd1) - Add OpenTelemetry trace linking. The new `@dudousxd/nestjs-telescope-otel`
  package implements core's `TraceContextProvider` SPI by reading the active
  OpenTelemetry span via `@opentelemetry/api` (`OtelTraceContextProvider`,
  optional peer, read-only — never creates or exports spans, degrades to `null`
  when no span/API is present). Core gains the `TraceContextProvider` SPI,
  `traceId`/`spanId` on each `Entry`, and a `meta.traceLink` template so the UI
  can deep-link entries to a trace backend; the MikroORM storage provider adds the
  corresponding trace columns so the ids survive persistence. The Redis storage
  provider now reconstructs `traceId`/`spanId` when reading entries back, and the
  dashboard shows a Trace row in the entry detail with a clickable deep-link when
  `traceLink` is configured.

### Patch Changes

- [`090cd1f`](https://github.com/DavideCarvalho/nestjs-telescope/commit/090cd1ff871dbe46c1c877a26f90496550b5304c) - Dashboard insights, charts, and trace grouping. Core gains a `StatsService` +
  `GET /stats` endpoint with per-type analytics (latency p50/p95/p99, query-family
  breakdown, cache hit/miss ratio, request status breakdown) and an `EntryQuery.traceId`
  filter across all storages. The schedule watcher now tags scheduled runs with a stable
  `schedule` tag. The dashboard adds a per-type insights header with Recharts cards, cache
  hit/miss badges, a working Schedule view (job entries tagged `schedule`), and a
  `#/traces/:traceId` page that groups every entry sharing an OpenTelemetry trace.

- [`6a4d8d5`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6a4d8d56321d3840fe64e646130ccfdafcfb1bdd) - Batch pulse two-pass hydration into ONE query. `EntryQuery` gains an optional
  `ids?: string[]` filter: when set, only entries whose `id` is in the set are
  returned (ANDed with every other filter; an empty array returns no rows). Each
  storage applies it natively — SQLite via `id IN (...)`, MikroORM via
  `id: { $in }`, in-memory via a membership `Set`, and Redis via a single `MGET`
  of the entry keys (the big win — it skips the index scan entirely). The pulse
  service now hydrates the displayed rows (top-N slowest + exception reps + N+1
  reps) with one batched `get({ ids })` instead of N per-id `find()` round-trips,
  cutting pulse latency against a remote store. Pulse output shape is unchanged.

- [`c4222b1`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c4222b16ef4c0fc9c61694eb67033f03369ff24e) - Speed up the `/pulse` and `/timeseries` analytics endpoints by aggregating over
  a content-less projection instead of reading every entry's heavy `content` JSON
  blob.

  `EntryQuery` gains an `omitContent?: boolean` flag. When set, `get()` returns
  entries with `content: null` and the provider skips reading/parsing the content
  column where its driver allows:

  - **mikro-orm**: projects every persisted column EXCEPT `content` via MikroORM's
    `fields` option, so the blob never leaves the database (the main win on MySQL).
  - **sqlite**: SELECTs the content-less column list and skips JSON parsing.
  - **in-memory**: returns shallow copies with `content` nulled.
  - **redis**: stores the whole entry as one blob, so it must read it anyway —
    `omitContent` nulls `content` after parse (correct, but no projection benefit).

  `timeseries` now scans content-less (bucketing only needs `createdAt`/`type`).
  `pulse` runs two passes: pass 1 aggregates the whole window content-less
  (counts, slowest candidates, exception families, N+1 hotspots); pass 2 hydrates
  `content` for ONLY the few displayed rows (top-N slowest, one representative per
  reported exception family, one per reported N+1 family) via targeted `find`s.
  The pulse output shape is unchanged.

  At ~10k entries with large content blobs this drops pulse and timeseries from
  several seconds to a fraction of a second.

- Updated dependencies [[`73b50ad`](https://github.com/DavideCarvalho/nestjs-telescope/commit/73b50ad00193127271fdec36ad080d2858045922), [`9126bb0`](https://github.com/DavideCarvalho/nestjs-telescope/commit/9126bb04777cdaec6af3b0a1c5fe6f91d055ce82), [`1f00e62`](https://github.com/DavideCarvalho/nestjs-telescope/commit/1f00e62c8e60482b64251813680a5f866ef1619a), [`090cd1f`](https://github.com/DavideCarvalho/nestjs-telescope/commit/090cd1ff871dbe46c1c877a26f90496550b5304c), [`b7326b3`](https://github.com/DavideCarvalho/nestjs-telescope/commit/b7326b33d8d55b5f1ac5de4256f5e1980278699e), [`bfc0e26`](https://github.com/DavideCarvalho/nestjs-telescope/commit/bfc0e268388b5563d05c24e4de6ff99c74d1201a), [`7797a2a`](https://github.com/DavideCarvalho/nestjs-telescope/commit/7797a2a1554aff49bb59f5ca1b204974a7e04a41), [`6817fe6`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6817fe62775b1ff847fdb1038d3298e7709569e0), [`20ceb87`](https://github.com/DavideCarvalho/nestjs-telescope/commit/20ceb878cd4495dfbc7a3c71d882ae216a633757), [`1dd4db0`](https://github.com/DavideCarvalho/nestjs-telescope/commit/1dd4db0f3cd46d04b35ac112343cfb424c2d3190), [`a9f517c`](https://github.com/DavideCarvalho/nestjs-telescope/commit/a9f517c076461aef55cfb90d072ec38427ace91b), [`9d8eb65`](https://github.com/DavideCarvalho/nestjs-telescope/commit/9d8eb6562a7584801d5aa8b74491091f0fade5f9), [`418f1f0`](https://github.com/DavideCarvalho/nestjs-telescope/commit/418f1f0421948b40b25f845441a716fa4c6655c2), [`e76980d`](https://github.com/DavideCarvalho/nestjs-telescope/commit/e76980ddd7ee740f1b337a422a98ca98d97a007e), [`80c8f97`](https://github.com/DavideCarvalho/nestjs-telescope/commit/80c8f9769c8ab9ee724635086740910bc4d44ea3), [`e14ac60`](https://github.com/DavideCarvalho/nestjs-telescope/commit/e14ac603551372fc3767c63a349c509582b5e6ab), [`6fa0946`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6fa0946f5543868704864af2e32793eb448ac827), [`d507547`](https://github.com/DavideCarvalho/nestjs-telescope/commit/d507547df3c13e76e90b8a97c4e3e1d8aef25bd1), [`affd07e`](https://github.com/DavideCarvalho/nestjs-telescope/commit/affd07e4cb9ee85cfabaabed424833e8c638d04a), [`6a4d8d5`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6a4d8d56321d3840fe64e646130ccfdafcfb1bdd), [`c1f1ec9`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c1f1ec903d470d6b884924e2713de305b61b7481), [`cad6dae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/cad6dae0dba4f22e476d78c23ce2f74f7f6848e4), [`c8596c8`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c8596c85712880cb235e8cce059a1d93d339e9bd), [`c4222b1`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c4222b16ef4c0fc9c61694eb67033f03369ff24e), [`de29d2f`](https://github.com/DavideCarvalho/nestjs-telescope/commit/de29d2f519b1f25bc702c9dcc737d99b4751c8c9), [`10a3bc2`](https://github.com/DavideCarvalho/nestjs-telescope/commit/10a3bc224f6e0b1a237e1e7631acad70493b4c12), [`abde392`](https://github.com/DavideCarvalho/nestjs-telescope/commit/abde39264effb31b0524cc4fa89a335276c8dccb), [`8ff32a2`](https://github.com/DavideCarvalho/nestjs-telescope/commit/8ff32a2cc95775224eea3377460d91674dfda47f), [`5f2eddd`](https://github.com/DavideCarvalho/nestjs-telescope/commit/5f2eddd0ed5d72bf1de323b45870d7ddcaf64349), [`b14a201`](https://github.com/DavideCarvalho/nestjs-telescope/commit/b14a20175eae3d3017e8cbc068d367a03f634175), [`a90ef56`](https://github.com/DavideCarvalho/nestjs-telescope/commit/a90ef569ba12484bece07d8de2045e13ff2ff528), [`593bcc8`](https://github.com/DavideCarvalho/nestjs-telescope/commit/593bcc85ad6558040c62ba66bd1e5e0cbe5a6ac7), [`7b6636b`](https://github.com/DavideCarvalho/nestjs-telescope/commit/7b6636b54438427cd53ea0cbedd186b77d807169), [`e64f35a`](https://github.com/DavideCarvalho/nestjs-telescope/commit/e64f35a1bb7cae15b2ef24404888463d04f81eef), [`4892ef6`](https://github.com/DavideCarvalho/nestjs-telescope/commit/4892ef61e45e5486d34c7ec82764e6767fe8233d)]:
  - @dudousxd/nestjs-telescope@1.0.0
