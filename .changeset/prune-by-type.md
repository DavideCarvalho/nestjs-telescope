---
"@dudousxd/nestjs-telescope-mikro-orm": patch
---

The pruner's batches no longer read the whole retained backlog to find the rows they delete.

The global cutoff (every type but the ones with their own retention) ran as one
`created_at < ? AND type NOT IN (…) ORDER BY created_at` query. The planner walked the `created_at`
index from the oldest row and stepped over every row of the excluded types, which are excluded
because they are kept longer: next to 2.8M `durable` entries kept for 24 h, a batch of 1,000 rows
took 10 s, so a cycle's batches ran back to back on the database. The batch now prunes one type at a
time (the types found by index seeks), each as a range of a new `(type, created_at, id)` index, which
the additive schema update adds on the next boot on every dialect. A type with nothing expired costs
one index seek. Same rows deleted, oldest first within each type, one shared `limit` per batch.
