---
"@dudousxd/nestjs-telescope-mikro-orm": patch
---

Flushes are written as plain multi-row INSERTs instead of going through the unit of work.

`store()` created a managed entity per entry and ran `em.flush()`, which computes a change set per
entity and wraps the write in a transaction. Entries are write-once, so none of that was needed,
and on a host recording a wide durable fan (80k entries in a 40k-step run) it cost more CPU than
the INSERTs themselves. The batch is now inserted directly, in chunks of the ORM's `batchSize`, so
a large flush stays under every driver's bound-parameter limit. The same rows are written; the
recording process spent about 10% less CPU over that run.
