---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-mikro-orm': patch
'@dudousxd/nestjs-telescope-redis': patch
---

Batch pulse two-pass hydration into ONE query. `EntryQuery` gains an optional
`ids?: string[]` filter: when set, only entries whose `id` is in the set are
returned (ANDed with every other filter; an empty array returns no rows). Each
storage applies it natively — SQLite via `id IN (...)`, MikroORM via
`id: { $in }`, in-memory via a membership `Set`, and Redis via a single `MGET`
of the entry keys (the big win — it skips the index scan entirely). The pulse
service now hydrates the displayed rows (top-N slowest + exception reps + N+1
reps) with one batched `get({ ids })` instead of N per-id `find()` round-trips,
cutting pulse latency against a remote store. Pulse output shape is unchanged.
