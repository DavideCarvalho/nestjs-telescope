---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-bullmq': minor
---

Add a driver-agnostic live-queue read layer. Core gains the `QueueManager` SPI
(`QueueManager`, `QueueManagerContext`, `QueueManagerRegistry`) and its DTO types
(`QueueState`, `QueueCounts`, `QueueSummary`, `QueueJob`, `QueueJobDetail`,
`JobPage`), wired through a `queueManagers` option on `TelescopeModule.forRoot`
and surfaced as read endpoints under the existing authorizer:
`GET /telescope/api/queues/live`, `…/live/:driver/:queue/counts`,
`…/live/:driver/:queue/jobs?state=`, and `…/live/:driver/:queue/jobs/:id`.

`@dudousxd/nestjs-telescope-bullmq` adds `BullMqQueueManager`, which discovers
`@nestjs/bullmq` `Queue` instances via `DiscoveryService` (duck-typed, optional
explicit allow-list) and reads them through the BullMQ `Queue` API to report
live counts, the jobs in each list, and per-job detail. Job payloads are passed
through core redaction before leaving the server. Reads only this phase — queue
actions (retry/remove/promote/redrive) land in Phase 2.
