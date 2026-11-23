# @dudousxd/nestjs-telescope-drizzle

> [Drizzle ORM](https://orm.drizzle.team) storage and query capture for
> [@dudousxd/nestjs-telescope](https://github.com/DavideCarvalho/nestjs-telescope).
> `DrizzleStorageProvider` keeps Telescope's entries in your own PostgreSQL through
> `drizzle-orm/node-postgres`, and `telescopeDrizzleLogger` records every query your app runs,
> correlated to the request or job that ran it.

Requires PostgreSQL, `drizzle-orm` 0.36 or later and `pg` 8. MySQL and SQLite are not supported.

## Install

```sh
npm install @dudousxd/nestjs-telescope @dudousxd/nestjs-telescope-drizzle drizzle-orm pg
```

## Storage

Hand the provider your Drizzle database. No migration is needed: at boot it creates its tables in
that database.

```ts
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { DrizzleStorageProvider } from '@dudousxd/nestjs-telescope-drizzle';
import { drizzle } from 'drizzle-orm/node-postgres';

const db = drizzle({ client: pool }); // your app's own instance

@Module({
  imports: [TelescopeModule.forRoot({ storage: new DrizzleStorageProvider(db) })],
})
export class AppModule {}
```

It also takes a `pg` Pool, or Pool options for a database of its own (recommended for high write
volume):

```ts
new DrizzleStorageProvider({ connectionString: process.env.TELESCOPE_DATABASE_URL });
```

### Settings

```ts
new DrizzleStorageProvider(db, {
  schema: 'telescope',     // a PostgreSQL schema for every Telescope table (created at boot)
  ensureSchema: true,      // create and heal the tables at boot; false when your migrations do it
  dedicatedPool: false,    // true (or { max }) for a pool of its own with your pool's settings
  batchSize: 500,          // rows per INSERT
});
```

### How it works

- **Your pool, its own Drizzle instance.** Given your `NodePgDatabase` or Pool, the provider borrows
  the pool and builds its own Drizzle instance on it, without a logger. Drizzle keeps the logger on
  the instance, so your Telescope query logger never records Telescope's own writes, and there is
  no capture loop. A borrowed pool is never closed. With `dedicatedPool`, or when your Drizzle
  instance wraps a single `pg.Client` (which cannot run Telescope's transactions next to yours),
  the provider opens a pool of its own with your connection settings (`pickHostConnection`) and
  closes it at shutdown.
- **Sharing your pool is the default**, unlike the MikroORM package, which always opens its own.
  Telescope's flushes, prunes and Overview reads then take connections from your pool and run
  under its settings (`statement_timeout` included). On a small pool, set `dedicatedPool: true`
  (or `{ max }`).
- **Tables at boot, behind a fingerprint.** `init()` runs additive, idempotent DDL
  (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS` for the nullable columns, `CREATE INDEX
  IF NOT EXISTS`) under an advisory lock, then stores a sha256 of it in `telescope_schema_meta`.
  Later boots read that one row and run nothing else: `ALTER TABLE` would take the table's
  exclusive lock even when the column is there. Nothing is ever dropped, so an index you add
  survives every upgrade.
- **Same tables as the MikroORM package.** Column types, lengths and index names match what
  `@dudousxd/nestjs-telescope-mikro-orm` creates on PostgreSQL, so either package can run on a
  database the other created.
- **Flushes are multi-row INSERTs**, `batchSize` rows each. A flush that needs several runs in one
  transaction, so it is stored whole or not at all.
- **Rollups merge in the database** with `INSERT ... ON CONFLICT DO UPDATE`: count and sum add, max
  keeps the larger value and the histogram adds cell by cell, so pods writing the same minute never
  lose each other's increments.
- **Pruning** is bounded (`pruneScopedBatch` deletes the oldest rows in short batches) and guarded
  by a lease in `telescope_leases`, taken with one atomic upsert.
- **Pulse and the timeseries aggregate in SQL** (`aggregate`), with `date_bin` on PostgreSQL 14+.

### Managing the tables with drizzle-kit

The table definitions are exported, so drizzle-kit can create them with your migrations instead:

```ts
// db/schema.ts
export { telescopeEntries, telescopeRollups, telescopeLeases, telescopeSchemaMeta } from '@dudousxd/nestjs-telescope-drizzle';

// in a schema of their own:
import { telescopeTables } from '@dudousxd/nestjs-telescope-drizzle';
export const { entries, rollups, leases, schemaMeta, namespace } = telescopeTables('telescope');
```

Then turn the boot DDL off: `new DrizzleStorageProvider(db, { ensureSchema: false })`. A spec
checks that the tables drizzle-kit generates from these definitions and the ones the boot DDL
creates are identical, column for column and index for index.

If you leave the tables to the provider instead, keep them out of your own migrations:

```ts
// drizzle.config.ts
import { telescopeManagedTables } from '@dudousxd/nestjs-telescope-drizzle';

export default defineConfig({
  tablesFilter: ['*', ...telescopeManagedTables().map((name) => `!${name}`)],
});
```

### Indexes for the Overview

The console's Overview and Pulse read whole windows. Opt-in indexes make those reads cheap on a
large table. They are not created at boot; run them once, from a migration or a script:

```ts
await storage.createOverviewIndexes(); // returns the names it created; a rerun creates none
// or the statements, each outside a transaction:
overviewIndexStatements({ schema: 'telescope' });
```

The exported tables do not declare these indexes, so if your own `drizzle-kit` config includes
the Telescope tables, `drizzle-kit push` will offer to drop them. Exclude the tables with
`telescopeManagedTables()` (as above), or skip those drops.

They are `(duration_ms) WHERE duration_ms IS NOT NULL`, `(created_at, type)` and
`(type, created_at) INCLUDE (family_hash, batch_id, duration_ms)`, built `CONCURRENTLY`, plus lower
autovacuum thresholds for the table.

## Query capture

Give your Drizzle instance the Telescope logger:

```ts
import { telescopeDrizzleLogger } from '@dudousxd/nestjs-telescope-drizzle';

const db = drizzle({ client: pool, logger: telescopeDrizzleLogger() });
```

Drizzle calls the logger inside the caller's async context, so each query entry joins the request
or job batch that ran it, and the N+1 detector (`detectNPlusOne`) works on it. With no argument
the logger records through Telescope's global sink once `TelescopeModule` is up, so the order in
which Drizzle and Nest start does not matter; pass a `record` function to send entries elsewhere.

Options:

- `echo: true` also logs each query the way Drizzle's `logger: true` does (or pass a Drizzle
  `Logger` to forward to).
- `coverQueries: false` keeps the OpenTelemetry bridge's `pg` spans (by default the logger marks
  queries as covered and the bridge skips them, so nothing is recorded twice). That default is
  process-wide: it also drops `pg` spans from code that does not use Drizzle (raw `pg` calls,
  another ORM), and with them their durations and `slow` tags. Pass `false` if you rely on those.

Drizzle's logger is called before a query runs and never after, so query entries carry no
duration, and none is tagged `slow`. If you need query timings, run the OpenTelemetry `pg`
instrumentation with `coverQueries: false`.

## Exports

| Export | Description |
|--------|-------------|
| `DrizzleStorageProvider` | `StorageProvider` on PostgreSQL through Drizzle; creates its tables at boot |
| `pickHostConnection(client)` | The connection settings of a `pg` Pool or Client, for a pool of the provider's own |
| `telescopeTables(schema?)`, `telescopeEntries`, `telescopeRollups`, `telescopeLeases`, `telescopeSchemaMeta` | The `pgTable` definitions |
| `telescopeManagedTables()` | The table names the provider manages |
| `bootStatements(schema?)`, `schemaMetaDdl(schema?)` | The boot DDL, for a migration of your own |
| `overviewIndexStatements(options?)`, `OVERVIEW_INDEX_NAMES` | The opt-in Overview indexes |
| `telescopeDrizzleLogger(record?, options?)`, `TelescopeDrizzleLogger` | The Drizzle `Logger` that records queries |
| `detectNPlusOne`, `queryFamilyHash` | Re-exported from core |

## License

MIT © Davi Carvalho
