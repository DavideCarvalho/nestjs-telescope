---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-mikro-orm': minor
---

Add `MikroOrmStorageProvider`: persist Telescope entries to MySQL/SQLite through
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
