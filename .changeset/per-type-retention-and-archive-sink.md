---
"@dudousxd/nestjs-telescope": minor
"@dudousxd/nestjs-telescope-mikro-orm": minor
"@dudousxd/nestjs-telescope-redis": minor
---

Per-type prune retention and an archive sink that exports entries before they are pruned.

- `prune.perType` overrides the global `after` cutoff for specific entry types (e.g. `{ after: '5m', perType: { exception: '7d' } }`). Types without an override keep using the global cutoff, so omitting `perType` is exactly backward compatible. Per-type durations are validated at module init like `after`.
- `archive` hands a type's doomed entries to a host-owned `sink` (S3, a data lake, cold storage) **before** the pruner deletes them, in bounded batches. A failing sink keeps the entries (retried next cycle) and never crashes the host or stops the pruner.
- New optional `StorageProvider.pruneScoped(input)` method backs per-type deletes; it is implemented for every in-repo adapter (SQLite, MikroORM, Redis, in-memory). Third-party providers without it fall back to the global cutoff with a one-time warning.
