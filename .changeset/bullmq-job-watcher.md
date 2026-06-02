---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-bullmq': minor
---

Add the BullMQ job watcher (`@dudousxd/nestjs-telescope-bullmq`). It discovers
`@nestjs/bullmq` `WorkerHost` processors and wraps each job in a `'queue'` batch,
capturing job outcome/duration/attempts and correlating the queries and
exceptions a job emits to that job. Core now imports `DiscoveryModule` so
discovery-based watchers can resolve `DiscoveryService`, and the canonical
`JobContent` gains `id` and `maxAttempts`.
