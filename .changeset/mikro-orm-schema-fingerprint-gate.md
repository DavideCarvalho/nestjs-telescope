---
"@dudousxd/nestjs-telescope-mikro-orm": minor
---

Gate the boot-time schema reconciliation behind a metadata fingerprint so
steady-state boots stop paying for a full-database introspection. The provider's
`init()` previously ran `schema.update({ safe: true })` on every boot, which
diffs the WHOLE database's `information_schema` against telescope's entities and
emits zero DDL once the schema is settled — ~1.5–3s of round-trips on a remote
DB, every time.

`init()` now: ensures the database exists, maintains an idempotent
`telescope_schema_meta` marker table (one row), and compares the stored
fingerprint against one computed purely in memory from entity metadata (sorted
tables/columns/indexes, plus the platform name, configured collation, and a
hand-bump `SCHEMA_REVISION`). When they match it SKIPS `ensureDatabase`'s heavy
sibling `schema.update` entirely. Only a fresh DB, an entity change, or a
`SCHEMA_REVISION` bump invalidates the fingerprint and runs the additive
`schema.update`, after which the marker is re-cached. The heal runs under a
best-effort advisory lock (MySQL `GET_LOCK` / PostgreSQL `pg_advisory_lock`,
no-op on SQLite) with a re-check so concurrent pods don't all introspect at
once. Behavior is unchanged from the caller's view: fresh databases and CI still
auto-create their schema with zero configuration.
