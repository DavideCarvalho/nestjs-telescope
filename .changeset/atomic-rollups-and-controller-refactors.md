---
"@dudousxd/nestjs-telescope": patch
"@dudousxd/nestjs-telescope-redis": patch
"@dudousxd/nestjs-telescope-mikro-orm": patch
---

Fix (redis): make rollup merges atomic via a per-bucket Lua script (`HINCRBY` count/sum/histogram cells + max CAS + `ZADD`), removing the read-modify-write race that could drop concurrent rollup writes; `readHistogram` still merges any legacy JSON blob.

Fix (mikro-orm): honor empty-string entry-query filters (switched truthy checks to `!== undefined` for type/familyHash/batchId/tag), matching the in-memory/sqlite/redis providers.

Internal refactors (behavior-preserving): drive `jobAction` off an `ACTION_METHOD` dispatch map, extract a module-level `parseWindowMs` (deduping 5 identical parsers), and move the request-replay subsystem out of the controller into `nest/request-replay.ts`.
