# @dudousxd/nestjs-telescope-typeorm

TypeORM query watcher for [`@dudousxd/nestjs-telescope`](../../README.md). Tees
every executed SQL statement into the telescope recorder, correlated to the
active request batch.

## How it works

TypeORM lets you supply a custom `Logger` at `DataSource` construction. This
package ships `TelescopeTypeOrmLogger` (a `Logger` implementation) whose
`logQuery` records each statement. Because the logger runs in the query's async
context, queries correlate to the active request batch via ALS — exactly like
the MikroORM adapter.

## Usage

The host wires the logger into the `DataSource`:

```ts
import { DataSource } from 'typeorm';
import { telescopeTypeOrmLogger } from '@dudousxd/nestjs-telescope-typeorm';

const dataSource = new DataSource({
  // ...your connection options...
  logging: true, // or ['query'] — required so TypeORM calls logQuery
  logger: telescopeTypeOrmLogger((input) => telescopeService.record(input)),
});
```

`logging: true` (or `['query']`) must be enabled, otherwise TypeORM never calls
`logQuery` and nothing is recorded.

## Durations

TypeORM's `logQuery` does not provide an execution time, so normal queries are
recorded with `durationMs: null`. Slow queries are surfaced separately by
TypeORM via `logQuerySlow(time, ...)` (gated by `maxQueryExecutionTime`); those
are recorded with a real `durationMs` and a `slow` tag.

```ts
telescopeTypeOrmLogger((input) => telescopeService.record(input), { slowMs: 1000 });
```
