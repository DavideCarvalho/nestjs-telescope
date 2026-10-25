---
"@dudousxd/nestjs-telescope-mikro-orm": patch
---

The pruner's batches no longer read the whole retained backlog to find the rows they delete.

The global cutoff (every type but the ones with their own retention) ran as one
`created_at < ? AND type NOT IN (…) ORDER BY created_at` query. The planner walked the `created_at`
index from the oldest row and stepped over every row of the excluded types, which are excluded
because they are kept longer: next to 2.8M `durable` entries kept for 24 h, a batch of 1,000 rows
took 10 s, so a cycle's batches ran back to back on the database. The batch now prunes one type at a
time (the types found by index seeks), ordered by id, which is time-ordered (UUIDv7) and lets a
`type = ?` read walk the `type` index: 0.2–0.3 s a batch on the same table. Same rows deleted,
oldest first, one shared `limit` per batch.
