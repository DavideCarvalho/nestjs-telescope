---
"@dudousxd/nestjs-telescope-mikro-orm": patch
---

Flushes are written as plain multi-row INSERTs instead of going through the unit of work.

`store()` created a managed entity per entry and ran `em.flush()`, which computes a change set per
entity. Entries are write-once, so that work was not needed, and on a host recording a wide durable
fan (80k entries in a 40k-step run) it cost more CPU than the INSERTs themselves. The batch is now
inserted directly, in chunks of the ORM's `batchSize` so a large flush stays under every driver's
bound-parameter limit. A flush that spans several chunks still runs in one transaction, so it is
stored whole or not at all and the recorder's retry never collides with rows from a failed attempt.
The same rows are written, for about half the CPU per flush.
