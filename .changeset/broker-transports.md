---
'@dudousxd/nestjs-telescope': minor
---

Broker transports for tenant → control plane: `transports.bullmq({ connection, queue?, attempts? })` and `transports.redis({ connection | client, prefix? })`, set as `tenant.transport` on tenants and as `transport` on the control plane, which consumes the broker and keeps its HTTP ingest route (mixed fleets work, deduped across both). Every message is verified with `verifyTenant`, refused or poison messages are dead-lettered (BullMQ's failed set, `<prefix>:ingest:dead`), transient failures are retried. `bullmq` and `ioredis` are optional peers, loaded only when their driver is used.
