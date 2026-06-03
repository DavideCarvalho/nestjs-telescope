---
'@dudousxd/nestjs-telescope-mikro-orm': minor
---

Add `MikroOrmStorageProvider`: a `StorageProvider` implementation that persists
Telescope entries to MySQL/SQLite through the host's MikroORM `EntityManager`.
Ships the `TelescopeEntry` `EntitySchema` (table `telescope_entries`) for the
host to register. Newest-first keyset pagination via an `$or` `(createdAt, id)`
position, cross-driver tag filtering against a space-padded `tagsText` column,
and `keepLast`-aware pruning. Every operation forks the `EntityManager` so it is
safe to use outside the request scope. Lets apps reuse their primary database
for Telescope storage instead of standing up Redis.
