# @dudousxd/nestjs-telescope-clickhouse

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

## 0.1.0

### Minor Changes

- [#165](https://github.com/DavideCarvalho/nestjs-telescope/pull/165) [`6a1ecea`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6a1ecea013ea550167c362b69fcc74f27ec1c749) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add `@dudousxd/nestjs-telescope-clickhouse`: Telescope storage on ClickHouse, for high volume and long retention

  Entries live in a `ReplacingMergeTree(version, is_deleted)` partitioned by day and ordered by `(type, created_at, id)`, with bloom-filter skip indexes on `id`, `batch_id`, `trace_id`, `family_hash` and `tags`. Retention is the table's TTL, generated per type from a `retention` option and re-applied with `ALTER TABLE … MODIFY TTL` at boot only when it changed, so there is no pruner: the `prune*` methods are no-ops that report 0 and no lease is needed. Inserts use `async_insert` with `wait_for_async_insert`, `update()` writes a new row version read back through `FINAL`, and dashboard timeseries come from a `SummingMergeTree` rollup table. Talks to the HTTP interface via `@clickhouse/client`, self-hosted or ClickHouse Cloud, with its own client or one the host owns. Shared new-exception dedup (`markFamilySeen`) runs on a `KeeperMap` table in strict mode: a new family is claimed by an insert only one replica can win, and an expired one by a version-checked update whose claim token is read back, so exactly one caller per window gets `true`. On a server without Keeper the provider warns once at boot and leaves the method out, and the alert dedups per pod as on any store without it. Passes the shared storage conformance suite against a real server with embedded Keeper.
