# @dudousxd/nestjs-telescope-clickhouse

> ClickHouse storage provider for
> [@dudousxd/nestjs-telescope](https://github.com/DavideCarvalho/nestjs-telescope): one
> columnar store for high volume and long retention, with retention as the table's TTL.

## Install

```sh
pnpm add @dudousxd/nestjs-telescope-clickhouse @clickhouse/client
```

## Usage

```ts
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { ClickHouseStorageProvider } from '@dudousxd/nestjs-telescope-clickhouse';

TelescopeModule.forRoot({
  storage: new ClickHouseStorageProvider({
    url: process.env.CLICKHOUSE_URL,
    username: process.env.CLICKHOUSE_USER,
    password: process.env.CLICKHOUSE_PASSWORD,
    retention: { default: '24h', perType: { exception: '90d' } },
  }),
  // no `prune`: retention is the table's TTL
});
```

## Notes

- **Tables.** `init()` creates `telescope_entries` (`ReplacingMergeTree(version, is_deleted)`,
  `PARTITION BY toYYYYMMDD(created_at)`, `ORDER BY (type, created_at, id)`, bloom-filter skip
  indexes on `id`, `batch_id`, `trace_id`, `family_hash`, `tags`) and `telescope_rollups`
  (`SummingMergeTree`). Rename them with `table` / `rollupTable`.
- **Retention** is a TTL generated from `retention` (24 hours for every type when omitted). Its
  fingerprint is kept in the table comment, and `init()` runs `ALTER TABLE … MODIFY TTL` only
  when it changed.
- **No pruner.** `prune`, `pruneScoped` and `pruneScopedBatch` are no-ops returning 0, and the
  provider has no prune lease.
- **`update()`** writes a new row version; every read uses `FINAL`.
- **Inserts** use `async_insert=1, wait_for_async_insert=1`; `asyncInsert: false` turns it off.
- **Host-owned client.** Pass `client` to reuse a `@clickhouse/client` instance; `close()` then
  leaves it open.
- **`markFamilySeen`** (one page per new exception family across pods) uses a `KeeperMap` table
  in strict mode, so it needs ClickHouse Keeper/ZooKeeper and `keeper_map_path_prefix` on the
  server. Without them the provider warns once at `init()` and omits the method; the alert then
  dedups per pod.

## Tests

`pnpm test` runs the shared conformance suite and the integration specs against
`CLICKHOUSE_URL` when set, else a throwaway `clickhouse/clickhouse-server:24.8-alpine` container
(`CLICKHOUSE_IMAGE` overrides it) running an embedded Keeper from `test/keeper.xml`; a second,
Keeper-less container covers the fallback. `CLICKHOUSE_URL` must have Keeper. Without a URL or
Docker, those suites are skipped with a warning.

See the [storage docs](https://davidecarvalho.github.io/aviary/docs/telescope) for when to pick
this store.

## License

MIT
