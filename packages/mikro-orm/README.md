# @dudousxd/nestjs-telescope-mikro-orm

> MikroORM query watcher for
> [@dudousxd/nestjs-telescope](https://github.com/DavideCarvalho/nestjs-telescope).
> Captures every executed SQL query, correlates it to the request that triggered
> it, tags slow queries, and exposes a pure N+1 detector. Also ships a
> `MikroOrmStorageProvider` so you can persist Telescope entries in your own
> MySQL/SQLite instead of Redis.

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

### Capturing without console noise

Capture only works while MikroORM's `debug` is enabled — that's what makes it
call the logger. But `debug` also echoes every query to stdout, which drowns your
logs. To feed Telescope **without** the console spam, pass `silent: true`:

```ts
loggerFactory: telescopeMikroOrmLogger(
  (input) => telescope.record(input),
  { slowMs: 100, silent: true },   // record into Telescope, but no stdout echo
),
```

Keep `debug: ['query']` enabled — `silent` swaps MikroORM's writer for a no-op,
so queries still flow into Telescope while nothing is printed. Leave `silent`
off (the default) if you want queries in both Telescope and the console.

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

## MySQL / SQLite storage

`MikroOrmStorageProvider` persists Telescope entries to your application's own
database through MikroORM, so you can use your existing MySQL (or SQLite) for
Telescope instead of standing up Redis. **No migration and no manual table
setup** — the provider owns a dedicated MikroORM scoped to a single
`TelescopeEntry` and self-heals its schema at boot. Just hand it your existing
`MikroORM`:

```ts
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { MikroOrmStorageProvider } from '@dudousxd/nestjs-telescope-mikro-orm';
import { MikroORM } from '@mikro-orm/core';

@Module({
  imports: [
    // your normal MikroOrmModule.forRoot({ ... }) — nothing to add here
    TelescopeModule.forRootAsync({
      inject: [MikroORM],
      useFactory: (orm: MikroORM) => ({
        // borrows the host's connection config; opens its own scoped connection
        storage: new MikroOrmStorageProvider(orm),
      }),
    }),
  ],
})
export class AppModule {}
```

Want Telescope on a **separate database** (recommended for high write volume)?
Pass explicit MikroORM connection options instead of the host `MikroORM`:

```ts
import { MySqlDriver } from '@mikro-orm/mysql';

new MikroOrmStorageProvider({
  driver: MySqlDriver,
  clientUrl: process.env.TELESCOPE_DATABASE_URL,
  // ensureSchema: false,  // opt out of boot-time schema sync (e.g. you manage it via migration)
});
```

How it works:

- **Dedicated, scoped connection.** The provider opens its OWN MikroORM that
  knows *only* `TelescopeEntry`. Two reasons this matters: (1) the schema diff
  can only ever touch `telescope_entries` — it is structurally incapable of
  altering your other tables; (2) it avoids a self-capture loop — if storage
  writes ran on the host connection (which has the query watcher's
  `loggerFactory` wired), every `INSERT INTO telescope_entries` would be captured
  as a query entry, recorded, flushed, and re-captured.
- **Self-healing schema at boot.** On `init()` the provider runs
  `schema.ensureDatabase()` + `schema.update({ safe: true })` — additive only:
  it creates `telescope_entries` if missing and adds any missing columns, and
  **never drops** a table or column. Set `ensureSchema: false` to disable (e.g.
  when you provision the table via your own migration).
- **Lifecycle.** `init()` is awaited by `TelescopeModule` at startup; `close()`
  closes the owned connection at shutdown. You don't call either yourself.
- **Keyset pagination** is newest-first (`createdAt DESC, id DESC`); the cursor
  encodes a `(createdAt, id)` position via `$or`, so paging resumes correctly
  even after older entries are pruned.
- **Tag filtering** runs against a space-padded `tagsText` column with
  `LIKE '% <tag> %'` (JSON-array predicates are not portable across MySQL and
  SQLite). The `tags` JSON column remains the source of truth for retrieval.

## Exports

| Export | Description |
|--------|-------------|
| `MikroOrmQueryWatcher` | Watcher marker — add to `TelescopeModule.forRoot({ watchers })` |
| `telescopeMikroOrmLogger(record, opts?)` | `loggerFactory`-compatible factory; `opts.slowMs` defaults to `100`, `opts.silent` (default `false`) suppresses MikroORM's console output while still recording |
| `TelescopeMikroOrmLogger` | `DefaultLogger` subclass (advanced: extend or instantiate directly) |
| `MikroOrmStorageProvider` | `StorageProvider` persisting entries to MySQL/SQLite; owns a dedicated scoped connection and self-heals its schema at boot |
| `TelescopeEntry` | `EntitySchema` for table `telescope_entries` (owned internally by the provider; exported for advanced use — you don't register it) |
| `detectNPlusOne(entries, threshold)` | Pure N+1 detector |
| `queryFamilyHash(sql)` | SQL template normalizer + FNV-1a hash (used internally) |

## License

MIT © Davi Carvalho
