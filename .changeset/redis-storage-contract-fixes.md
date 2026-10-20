---
'@dudousxd/nestjs-telescope-redis': patch
---

Bring `RedisStorageProvider` in line with the storage contract, as the new conformance suite found it was not

- **Same-millisecond entries are ordered by id descending**, like every other provider. The index orders them ascending, so pages are now read in whole-millisecond groups and each group is re-sorted.
- **Cursors are the shared `(createdAt, id)` keyset** (`encodeCursor`) rather than the internal index member, so an undecodable cursor starts from the first page instead of returning nothing, and a composite store can hand Redis a cursor it did not produce. A cursor issued before this release is treated as undecodable: that page restarts from the top once.
- **`prune`, `pruneScoped` and `pruneScopedBatch` delete only entries strictly older than the cutoff.** Entries stamped exactly at the cutoff were deleted too.
- **`tags()` honours the `TagQuery`** — most used first, ties by tag, `search` anywhere in the tag, `limit`/`offset` — instead of returning counts in hash order.
