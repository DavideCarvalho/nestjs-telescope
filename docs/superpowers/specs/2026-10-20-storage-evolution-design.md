# Storage evolution — from your database to tiered Parquet to ClickHouse

**Date:** 2026-10-20
**Status:** Design (pending review)
**Scope:** A documented path for growing Telescope's storage with an app's volume, and the two new adapters it needs: a **tiered** store (hot database + cold Parquet, read in pure JS by hyparquet, or by DuckDB where it is allowed) and a **ClickHouse** store. Plus a shared storage conformance suite every adapter runs.

## 1. Problem

Telescope's adapters all share one shape: every entry is a row in one table of a general-purpose database, and retention is a pruner issuing `DELETE`s. That shape is right for most apps and wrong past a certain write rate, and today the docs offer no way to tell where that point is or what to do after it.

Measured on a real host (flip: MikroORM store on the app's own MySQL, query capture on, `nestjs-durable` running a 150,000-child `ctx.all` fan with 50 workers):

| | |
|---|---|
| Entries written | 3.97M in 30 min (~2,200/s: 3.3M `query`, 600k `durable`) |
| `telescope_entries` after one run | 3.4 GB |
| Pruner capacity at the host's settings | ~830 rows/s (`batchSize` 1000 × `maxBatchesPerCycle` 50 per 60 s cycle) |
| Pruner backlog at the end of the run | `query` entries ~18 min past their 5 min window |
| App queries on the same database | read p99 7 ms, write p99 62 ms (idle: 3.6 / 14) |
| Throughput cost of capture | 154 → 108 children/s with query capture on |

The database stayed healthy. What broke was retention: the table grew ~2.6× faster than the pruner could shrink it, which is the same shape as the 755k-row / 21-concurrent-delete incident the bounded pruner was built for. Bounded deletes keep the locks short; they cannot make a row-store delete keep up with a write rate it was never sized for.

## 2. Goals / non-goals

**Goals**
- A **ladder** in the docs: which storage fits which volume, the signals that say "move up", and the config at each rung. Moving up is a config change, never a data migration.
- **Skippable rungs.** An app that already knows its volume goes straight to the rung it needs (most often: straight to ClickHouse).
- Two adapters that make the upper rungs real: `@dudousxd/nestjs-telescope-parquet` (tiered) and `@dudousxd/nestjs-telescope-clickhouse`.
- One **conformance suite** in `@dudousxd/nestjs-telescope-testing` that every adapter — in-repo or third-party — runs, so "implements `StorageProvider`" means the same thing everywhere.

**Non-goals**
- Moving existing entries between stores. Telescope is observability, not a system of record; a new store starts empty. (§7 shows the one backfill that is cheap anyway.)
- Changing the `StorageProvider` SPI. Both new adapters fit the existing contract.
- Making capture cheaper. The throughput cost above is the Recorder and watchers, upstream of storage; sampling is the lever for that and already exists.

## 3. The ladder

| Rung | Store | Fits | Move up when |
|---|---|---|---|
| **0 — Embedded** | SQLite file (core default) | Local dev, one process | You run more than one replica |
| **1 — Your database** | MikroORM / TypeORM / Prisma on the app's DB, or Redis | Multi-replica apps at modest volume | Telescope competes with the app for its database |
| **2 — A dedicated database** | Same adapters, own connection | Isolation without new infrastructure | The pruner can't keep up (warning: "per-cycle batch ceiling"), or retention needs exceed what a row store holds cheaply |
| **3 — Tiered** | Hot: rung 1/2 store, minutes of data. Cold: Parquet on S3 (or a directory), read by hyparquet (pure JS) or DuckDB | Long retention and high volume without operating a new database | Cold queries are too slow for how often you run them, or volume keeps growing |
| **4 — ClickHouse** | One columnar store, TTL retention | High volume, long retention, fast analytics over all of it | — |

The signals are all things Telescope can already report or warn about: the pruner's ceiling warning, Recorder drop counters, and table size. The docs page turns them into a decision table.

Rungs 1 and 2 already exist; the new work is rungs 3 and 4 and the guidance that connects them.

## 4. Rung 3 — tiered storage (`@dudousxd/nestjs-telescope-parquet`)

### 4.1 Shape

```ts
import { parquetColdStore, tieredStorage } from '@dudousxd/nestjs-telescope-parquet';

const cold = parquetColdStore({
  location: { s3: { bucket: 'obs', prefix: 'telescope/v1', client: s3 } }, // or { dir: '/var/telescope' }
  compaction: { every: '15m', targetFileMb: 128 },
  // engine: 'hyparquet' (default, pure JS) | { duckdb: { memoryLimit: '512MB', threads: 2 } }
});

TelescopeModule.forRoot({
  storage: tieredStorage({ hot: new MikroOrmStorageProvider(orm), cold }),
  prune: { after: '5m', intervalMs: 15_000, perType: { exception: '1h' } }, // how long entries stay HOT
  archive: cold.archive({ types: ['request', 'query', 'exception', 'job'] }), // what moves to COLD
});
```

It composes the pipeline Telescope already has instead of adding a new one:

- **`prune`** keeps meaning "how long an entry stays in the live store" — now the hot tier only, so the hot table stays minutes deep and its bounded deletes are cheap.
- **`archive`** keeps its contract — the pruner hands doomed entries to `sink` and deletes them only after it resolves — with the cold store as the sink. Types not listed are pruned without archiving, exactly as today.
- **Cold retention** is a bucket lifecycle rule per type prefix (or, for a directory, `cold.expire({ perType })` run by the pruner). Expiring a type's hour is deleting a prefix — no row-level delete exists in this tier.

### 4.2 Layout

```
<prefix>/type=<type>/dt=<yyyy-mm-dd>/hour=<hh>/<instanceId>-<uuid>.parquet
```

`type` first so a lifecycle rule can target a type, and a query filtered on type only lists that type's prefixes. Each pod writes its own files (append-only, no coordination). **Compaction** merges a closed hour's files into files of `targetFileMb` and deletes the inputs only after the merged file is written; it runs under the existing prune lease, so one process compacts.

Columns: `id`, `batch_id`, `type`, `family_hash`, `tags` (LIST<VARCHAR>), `content` (VARCHAR, JSON), `sequence`, `duration_ms`, `origin`, `instance_id`, `trace_id`, `span_id`, `created_at` (TIMESTAMP_MS). Sorted by `created_at, id` inside each file so row-group min/max statistics prune time-range scans.

### 4.3 Read routing

`tieredStorage` implements `StorageProvider` by routing each call:

| Call | Routed to |
|---|---|
| `store`, `update`, leases, `markFamilySeen` | hot |
| `find(id)`, `batch(batchId)` | hot; on a miss, cold |
| `get(query)` | hot, then cold for whatever the page still needs — a k-way merge on the `(createdAt, id)` keyset, so the cursor format and newest-first order are unchanged across the tier boundary |
| `get({ traceId })`, `get({ tag })`, `get({ search })` | both, merged |
| `tags()` | both, counts summed |
| `prune*` | hot (cold has its own retention) |
| Rollups (`RollupStore`) | hot — buckets are tiny and already aggregated |

`update()` only reaches hot. That is correct by construction: `update` completes a request entry seconds after it was stored, long before it can be archived.

Reads list only the partitions a query's `type` and time bounds can touch, then read each file through ranged `GetObject` calls on the host's own S3 client — the same client, credentials and endpoint (GovCloud, VPC endpoint, MinIO) the archive sink writes with. Inside a file, row groups are skipped on their `created_at`/`duration_ms` statistics and bloom filters (`batch_id`, `trace_id`, `id`).

### 4.4 Cold engine: hyparquet by default, DuckDB optional

Two engines can read the cold tier. The default is **hyparquet** (+ `hyparquet-writer` for writing, `hyparquet-compressors` for codecs): pure JavaScript, six packages, 1.3 MB, nothing native, nothing downloaded at runtime. **DuckDB** (`@duckdb/node-api`) is an opt-in engine for deployments that want faster wide scans and can ship it.

Measured on the cold layout (one file per type, sorted by `created_at`, 10k-row groups; 255k `query` + 45k `durable` entries, ~15 MB):

| Read | hyparquet | DuckDB |
|---|---|---|
| Newest 50 of a type | 18 ms | 9 ms |
| A type's last minute (30k rows) | 50 ms | 109 ms |
| Point lookup (`batch_id`) in 255k rows | 36 ms | 5 ms |
| One run's children (tag filter, 45k rows) | 14 ms | 18 ms |
| Full scan (`duration_ms >= 100`, 255k rows) | 267 ms | 24 ms |
| Write 300k rows | ~1 s | — |

Every read the dashboard makes stays under 300 ms with hyparquet; DuckDB is an order of magnitude faster only on full scans, which the dashboard does not issue (its aggregates come from rollups in the hot tier).

The deciding factor is what each engine puts in a hardened image. Scanned with the versions GameWarden pins (Trivy 0.71.1, Grype 0.114.0), with the flip gate's flags (all severities, `--ignore-unfixed`):

| Package set | Trivy | Grype | What the scanners can see |
|---|---|---|---|
| `hyparquet` 1.31.5, `hyparquet-writer` 0.17.0, `hyparquet-compressors` 1.1.2 | 0 | 0 | All of it: six npm packages of plain JS (the codecs are versioned packages too) |
| `@duckdb/node-api` 1.5.6-r.1 | 0 | 0 | Only the `package.json` files. The 70 MB `libduckdb.so`, with every library DuckDB statically links, is not cataloged by syft or Grype |
| `@clickhouse/client` 1.24.1 | 0 | 0 | All of it: two npm packages |

DuckDB's clean result is therefore a blind spot rather than a verification. And reading S3 with DuckDB needs the `httpfs`/`aws` extensions, which `@duckdb/node-api` does not link: on first use DuckDB downloads them from `extensions.duckdb.org` into `~/.duckdb`. That is blocked in air-gapped and IL environments, and where it isn't, it is a native binary fetched after the image was scanned. The DuckDB engine therefore never loads `httpfs`: it reads the same ranged buffers hyparquet does, fetched by the host's S3 client, and registers them as in-memory files.

### 4.5 The hot tier on the app's own database

The expected setup — and flip's — keeps the hot tier where rung 1 put it: the app's database, through the host ORM. Tiering bounds that table's **size**; it does not reduce the **writes** it takes. Every entry is still inserted into the app's database, then read once by the archiver and deleted, so the co-tenancy cost measured in §1 (app write p99 14 → 62 ms during the fan) stays. Sampling remains the lever for that.

What tiering adds is a second budget that has to keep up with the write rate: the archiver's. It moves at most `archive.batchSize × archive.maxBatchesPerCycle` entries per type per `prune.intervalMs` — 5,000 per type per cycle at today's defaults, ~330/s on a 15 s cycle. The 20k-child run wrote `durable` at ~500/s and sampled `query` at ~440/s, so with defaults the hot tier would fall behind and grow in the app's database exactly as the un-tiered table did. `cold.archive()` therefore returns its own defaults sized for Parquet — `batchSize: 5_000`, `maxBatchesPerCycle: 20` (100,000 per type per cycle, ~6,600/s on a 15 s cycle) — which also keeps cold files large. The hot tier's prune ceiling warning and a new archive-backlog warning (oldest un-archived entry older than twice its type's hot window) are the signals the docs point at.

### 4.6 Failure modes

- **Sink failure** (S3 down): the archive contract already handles it — the hot tier keeps the entries and retries next cycle. The hot table grows until S3 recovers; the pruner's existing ceiling warning fires.
- **Cold read failure**: hot results are still returned, with a `partial` flag the UI shows ("older entries unavailable"). A dashboard never errors because the cold tier is down.
- **DuckDB engine configured but not installed:** boot fails with an error naming the missing optional peer. It never silently falls back, because the two engines differ enough in speed that a silent switch would surprise whoever chose DuckDB.

## 5. Rung 4 — ClickHouse (`@dudousxd/nestjs-telescope-clickhouse`)

```ts
import { ClickHouseStorageProvider } from '@dudousxd/nestjs-telescope-clickhouse';

TelescopeModule.forRoot({
  storage: new ClickHouseStorageProvider({
    url: process.env.CLICKHOUSE_URL,
    retention: { default: '24h', perType: { exception: '90d', durable: '30d' } },
  }),
  // no `prune`: retention is the table's TTL
});
```

- **Table:** `ReplacingMergeTree(version)` `PARTITION BY toYYYYMMDD(created_at)` `ORDER BY (type, created_at, id)`, plus skip indexes on `batch_id`, `trace_id`, `family_hash` (bloom filter) and `tags` (bloom filter on array elements).
- **Retention:** a `TTL` clause generated from `retention` (`created_at + INTERVAL … DELETE WHERE type = '…'` per override, then the default). ClickHouse drops expired data during merges, so there is no pruner and no row-level delete; `prune*` methods are no-ops that report 0, and the host simply omits `prune`. Changing `retention` re-applies the TTL with `ALTER TABLE … MODIFY TTL` at boot.
- **Writes:** one `INSERT` per Recorder flush with `async_insert=1, wait_for_async_insert=1`, so many pods' small flushes are batched server-side and a resolved `store()` still means durable.
- **`update()`:** writes a new row with the same `id` and a higher `version`; reads use `FINAL` (or `argMax` per id on wide scans) so the latest version wins.
- **Leases:** not needed — nothing prunes. `tryAcquireLease` is omitted, which the pruner already tolerates.
- **Rollups:** a `SummingMergeTree` table fed by the same `RollupStore` SPI, so the dashboards' timeseries read pre-aggregated buckets exactly as on other stores.

## 6. Shared conformance suite

`@dudousxd/nestjs-telescope-testing` gains `describeStorageProvider(name, factory)`: store/find/get with every `EntryQuery` filter, keyset paging across concurrent inserts, `batch`, `tags`, `update`, every prune variant the provider declares, leases if declared, rollups if declared. Every in-repo adapter runs it (SQLite, in-memory, MikroORM, Redis, the two new ones — the containers via testcontainers, S3 via MinIO), and the custom-storage recipe tells third parties to run it too.

The suite also pins tier-boundary behaviour for `tieredStorage`: an entry is never returned twice while it is being archived, and paging through the boundary is gap-free.

## 7. Moving between rungs

A new store starts empty; entries in the old one age out on their own retention. The cold layout is chosen so the one backfill worth doing is a single statement:

```sql
-- rung 3 → rung 4: load the cold tier's history into ClickHouse
INSERT INTO telescope_entries
SELECT * FROM s3('https://<bucket>.s3.amazonaws.com/telescope/v1/type=*/dt=*/hour=*/*.parquet', 'Parquet');
```

## 8. Implementation order

1. Conformance suite, run against the existing adapters (finds contract drift before new code adds more).
2. Docs: the ladder page, linked from Storage, the storage packages page and the custom-storage recipe.
3. `@dudousxd/nestjs-telescope-clickhouse` — self-contained, and the rung most high-volume users will jump to directly.
4. `@dudousxd/nestjs-telescope-parquet` — the writer and `archive()` sink first (useful alone: queryable history from day one), then hyparquet reads and `tieredStorage` routing, then compaction, then the optional DuckDB engine.

## 9. Open questions

- **DuckDB in hardened images.** Resolved by making hyparquet the default (§4.4). Whether a deployment may opt into DuckDB is its own call: the scanners cannot see inside `libduckdb.so`.
- **ClickHouse Cloud vs. self-hosted.** The adapter targets the HTTP interface, which both expose; nothing in the design depends on the choice.
- **UI partial-results flag.** `Page` has no field for it today. Adding an optional `partial?: boolean` is additive, but it is a core type change and needs its own review.
