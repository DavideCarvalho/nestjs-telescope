# @dudousxd/nestjs-telescope-parquet

> Tiered storage for
> [@dudousxd/nestjs-telescope](https://github.com/DavideCarvalho/nestjs-telescope): your existing
> store stays a minutes-deep hot tier, and older entries move to Parquet files on S3 or a
> directory instead of being deleted. Reads merge both tiers on the same newest-first cursor.

Pure JavaScript by default ([hyparquet](https://github.com/hyparam/hyparquet)): nothing native,
nothing downloaded at runtime. DuckDB (`@duckdb/node-api`) is an optional engine.

## Install

```sh
pnpm add @dudousxd/nestjs-telescope-parquet
```

An S3 location uses your own `@aws-sdk/client-s3` client (an optional peer).

## Usage

```ts
import { parquetColdStore, tieredStorage } from '@dudousxd/nestjs-telescope-parquet';

const cold = parquetColdStore({
  location: { s3: { bucket: 'observability', prefix: 'telescope/v1', client: s3 } }, // or { dir }
  compaction: { every: '15m', targetFileMb: 128 },
  // engine: { duckdb: { memoryLimit: '512MB', threads: 2 } },
});

TelescopeModule.forRoot({
  storage: tieredStorage({ hot: new MikroOrmStorageProvider(orm), cold }),
  prune: { after: '5m', intervalMs: 15_000 }, // how long entries stay hot
  archive: cold.archive({ types: ['request', 'query', 'exception', 'job'] }), // what moves cold
});
```

## How it works

- **Layout:** `type=<type>/dt=<yyyy-mm-dd>/hour=<hh>/<instanceId>-<uuid>.parquet`, each file
  sorted by `(created_at, id)` in 10,000-row groups with statistics, and bloom filters on `id`,
  `batch_id`, `trace_id`. Each pod writes its own files.
- **Archiving** is core's `archive` pipeline with this store as the sink: hot entries are deleted
  only after their file is written. `cold.archive()` defaults to 5,000 × 20 entries per type per
  cycle.
- **Reads** skip partitions outside the query's type and time bounds, then row groups by their
  `created_at` statistics and bloom filters; a page of a type reads only the newest rows of the
  newest row group. `find`/`batch` on UUIDv7 ids look around the id's timestamp first.
- **Compaction** merges each closed hour's small files under the prune lease.
- **Retention:** a lifecycle rule per `type=<type>/` prefix, or the `retention` option.
- **Cold failures** never fail a read: hot results come back with `partial: true`.
- **DuckDB** never loads `httpfs`; it reads local copies of objects fetched through your S3
  client. Boot fails if it is configured but `@duckdb/node-api` is not installed.

## Tests

`pnpm test` runs the conformance suite against `tieredStorage` with a directory cold tier and
with an S3 cold tier on `S3_TEST_ENDPOINT` (plus `S3_TEST_ACCESS_KEY`/`S3_TEST_SECRET_KEY`) when
set, else a throwaway MinIO container (`MINIO_IMAGE` overrides the image). Without either, the S3
suites are skipped with a warning.

## License

MIT
