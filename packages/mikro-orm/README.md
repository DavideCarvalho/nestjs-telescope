# @dudousxd/nestjs-telescope-mikro-orm

> MikroORM query watcher for
> [@dudousxd/nestjs-telescope](https://github.com/DavideCarvalho/nestjs-telescope).
> Captures every executed SQL query, correlates it to the request that triggered
> it, tags slow queries, and exposes a pure N+1 detector.

**Status:** early development (`0.0.0`). Requires MikroORM v7+.

## Install

```sh
npm install @dudousxd/nestjs-telescope @dudousxd/nestjs-telescope-mikro-orm
```

## How query capture works

MikroORM v7 stores its logger in a private field set once at `Configuration`
construction time. Runtime logger replacement is not possible after the ORM is
built. Because of this, **the host must wire `loggerFactory` before constructing
the ORM** — that is the real, working integration path.

`MikroOrmQueryWatcher` is still registered in `watchers` (it marks the query
entry type and logs a clear warning if `loggerFactory` is missing), but it does
not capture queries on its own. The `loggerFactory` is the capture mechanism.

## Setup

Use `MikroOrmModule.forRootAsync` so `TelescopeService` can be injected before
MikroORM is constructed:

```ts
import { TelescopeModule, TelescopeService } from '@dudousxd/nestjs-telescope';
import {
  MikroOrmQueryWatcher,
  telescopeMikroOrmLogger,
} from '@dudousxd/nestjs-telescope-mikro-orm';
import { MikroOrmModule } from '@mikro-orm/nestjs';

@Module({
  imports: [
    TelescopeModule.forRoot({
      authorizer: () => true,          // restrict in production
      watchers: [new MikroOrmQueryWatcher()],
    }),

    // forRootAsync lets us inject TelescopeService, which isn't available
    // at module-definition time.
    MikroOrmModule.forRootAsync({
      inject: [TelescopeService],
      useFactory: (telescope: TelescopeService) => ({
        // ... your driver, dbName, entities, etc.
        debug: ['query'],
        loggerFactory: telescopeMikroOrmLogger(
          (input) => telescope.record(input),
          { slowMs: 100 },   // queries >= 100 ms get a 'slow' tag
        ),
      }),
    }),
  ],
})
export class AppModule {}
```

Queries recorded via `telescopeMikroOrmLogger` automatically inherit the active
ALS batch opened by the request middleware, so each query entry is correlated to
the request that triggered it.

## N+1 detection

```ts
import { detectNPlusOne } from '@dudousxd/nestjs-telescope-mikro-orm';

// Pass the query entries for a single request batch and a repeat threshold.
const insights = detectNPlusOne(batchEntries, 5);
// insights: Array<{ familyHash: string; count: number; sql: string }>
```

`detectNPlusOne` is a pure function — no I/O, no side effects. Feed it the
entries for one batch (filter by `batchId`) and it returns every query template
that ran at least `threshold` times.

## Exports

| Export | Description |
|--------|-------------|
| `MikroOrmQueryWatcher` | Watcher marker — add to `TelescopeModule.forRoot({ watchers })` |
| `telescopeMikroOrmLogger(record, opts?)` | `loggerFactory`-compatible factory; `opts.slowMs` defaults to `100` |
| `TelescopeMikroOrmLogger` | `DefaultLogger` subclass (advanced: extend or instantiate directly) |
| `detectNPlusOne(entries, threshold)` | Pure N+1 detector |
| `queryFamilyHash(sql)` | SQL template normalizer + FNV-1a hash (used internally) |

## License

MIT © Davi Carvalho
