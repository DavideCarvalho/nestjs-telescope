---
"@dudousxd/nestjs-telescope-mikro-orm": minor
---

`schema` option: `new MikroOrmStorageProvider(orm, { schema: 'telescope' })` puts Telescope's tables in their own schema. PostgreSQL gets a schema written into every statement (never `search_path`), created at boot when missing and found by name in the catalog first. On MySQL / MariaDB the schema is a database that Telescope's own connection opens. The marker table, rollup upserts, advisory-lock names and the schema fingerprint are all per schema. SQLite refuses a `schema` at `init()`. Without `schema`, nothing changes.
