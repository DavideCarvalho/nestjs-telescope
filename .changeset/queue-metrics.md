---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-bullmq': minor
---

Add Horizon-style queue metrics. A new `GET /telescope/api/queues?window=1h`
endpoint aggregates captured `job` entries into per-queue throughput, runtime
and wait-time percentiles, and failure rate (`QueueMetricsService` +
`aggregateQueueMetrics`). The BullMQ watcher now captures `waitMs`
(`processedOn − enqueue`) on each job, and the canonical `JobContent` gains a
`waitMs` field. `durationToMs` is extracted as a shared, exported util.
