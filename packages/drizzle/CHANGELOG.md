# @dudousxd/nestjs-telescope-drizzle

## 0.1.0

### Minor Changes

- [#217](https://github.com/DavideCarvalho/nestjs-telescope/pull/217) [`3e4e232`](https://github.com/DavideCarvalho/nestjs-telescope/commit/3e4e2323186745e3418dea5f9e79e38a68b9de9d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - New package: Drizzle ORM storage and query capture on PostgreSQL. `DrizzleStorageProvider` keeps entries, rollups and the prune lease in your own database through `drizzle-orm/node-postgres`, borrowing your pool through a Drizzle instance of its own (so Telescope's writes are never captured as queries), or opening a dedicated pool with your connection settings. It creates its tables at boot behind a fingerprint gate, or leaves them to drizzle-kit from the exported `pgTable` definitions, and implements the whole storage SPI: bounded batched pruning, leases, rollups merged in the database, SQL aggregation for Pulse and the timeseries, a `schema` option and the opt-in Overview indexes. `telescopeDrizzleLogger` records every query as a `query` entry correlated to its request or job.
