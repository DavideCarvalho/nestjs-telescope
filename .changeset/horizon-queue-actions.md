---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-bullmq': minor
---

Add gated queue **mutation** endpoints on top of the live-queue reads. The core
controller now exposes `POST /telescope/api/queues/live/:driver/:queue/jobs/:id/:action`
(`retry` / `remove` / `promote`) and `POST .../actions/:action` (`retry-all`,
`redrive`), each carrying `:action` so a single `TelescopeActionGuard` authorizes
them uniformly.

Mutations are **default-deny**: they run behind a new `authorizeAction` option
*in addition to* the read `authorizer`, and the guard fails closed. Without an
`authorizeAction` callback every mutation returns `403` — even for callers the
read authorizer already trusts. `authorizeAction(ctx, { driver, queue, action,
jobId?, state? })` opts in; returning falsy or throwing denies.

`BullMqQueueManager` implements `retry` / `remove` / `promote` / `retryAll`
against the real BullMQ `Job.retry()` / `Job.remove()` / `Job.promote()` and
`Queue.retryJobs()` APIs (`retryAll` returns the pre-action count for the state).
`redrive` remains SQS-only and returns `405` on the bullmq driver.
