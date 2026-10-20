---
'@dudousxd/nestjs-telescope-testing': minor
---

Add `describeStorageProvider`: the `StorageProvider` contract as a Vitest suite, on the new `@dudousxd/nestjs-telescope-testing/conformance` subpath

"Implements `StorageProvider`" meant only "compiles". The suite pins what the dashboard actually depends on: newest-first keyset paging `(createdAt DESC, id DESC)` including same-millisecond ties, cursors that outlive their entry, inserts that land between pages, every `EntryQuery` filter (exclusive `before`/`after`, `ids`, `search` before `omitContent`), `batch`, `tags` order, search and paging, `update`, and `prune` with `keepLast`. Optional SPI members — `pruneScoped`, `pruneScopedBatch`, the lease pair, `markFamilySeen`, `RollupStore` — are tested only when a provider has them, and `retention: 'ttl'` covers stores whose database expires rows itself. Every adapter in this repo now runs it; third-party adapters can too. Vitest is an optional peer, needed only for that subpath, and `makeEntry()` is exported alongside it.
