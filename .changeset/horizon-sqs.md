---
'@dudousxd/nestjs-telescope-sqs': minor
---

Add the SQS DLQ queue manager (`@dudousxd/nestjs-telescope-sqs`). `SqsQueueManager`
implements the live-queue `QueueManager` SPI for Amazon SQS as a **DLQ-only**
driver: `listQueues`/`counts` report approximate depths (source visible →
`waiting`, source in-flight → `active`, DLQ visible → `failed`) from
`GetQueueAttributes`; `listJobs('failed')` snapshots up to 10 DLQ messages via
`ReceiveMessage` (never deleting — they reappear after the visibility timeout) and
caches them so `getJob` can return the redacted body; every non-`failed` state is
empty. The single mutation is `redrive`, backed by native `StartMessageMoveTask`
(DLQ → source), gated by `authorizeAction` (default-deny).

The manager depends only on a small `SqsOps` port, so it is fully unit-testable
without AWS. The default `createAwsSqsOps(client)` factory is the **only** file
that imports `@aws-sdk/client-sqs` — there is no hard runtime dependency on the
AWS SDK; hosts may supply their own `SqsOps`.
