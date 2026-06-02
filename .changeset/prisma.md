---
'@dudousxd/nestjs-telescope-prisma': minor
---

Add the Prisma query watcher: captures every SQL statement (SQL + duration +
params) via `prisma.$on('query')` for the query log and slow-query visibility.
Note: Prisma emits query events detached from the caller's async context, so
captured queries do NOT correlate to their request/job batch (and N+1 detection,
which is per-batch, does not apply) — see the README caveat.
