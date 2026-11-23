---
"@dudousxd/nestjs-telescope-drizzle": minor
---

New package: Drizzle ORM storage and query capture on PostgreSQL. `DrizzleStorageProvider` keeps entries, rollups and the prune lease in your own database through `drizzle-orm/node-postgres`, borrowing your pool through a Drizzle instance of its own (so Telescope's writes are never captured as queries), or opening a dedicated pool with your connection settings. It creates its tables at boot behind a fingerprint gate, or leaves them to drizzle-kit from the exported `pgTable` definitions, and implements the whole storage SPI: bounded batched pruning, leases, rollups merged in the database, SQL aggregation for Pulse and the timeseries, a `schema` option and the opt-in Overview indexes. `telescopeDrizzleLogger` records every query as a `query` entry correlated to its request or job.
