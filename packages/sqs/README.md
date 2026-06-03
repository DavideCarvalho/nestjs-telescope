# @dudousxd/nestjs-telescope-sqs

SQS **dead-letter-queue** manager for
[`@dudousxd/nestjs-telescope`](../../README.md). It implements the live-queue
`QueueManager` SPI for Amazon SQS so the dashboard can report queue depth,
snapshot the messages stranded in a DLQ (with redacted bodies), and **redrive**
that DLQ back to its source queue.

## Install

```bash
pnpm add @dudousxd/nestjs-telescope-sqs
```

Peer deps: `@dudousxd/nestjs-telescope`, `@nestjs/common`, `@nestjs/core`,
`reflect-metadata`. There is **no hard dependency on `@aws-sdk/client-sqs`** — the
SDK is touched in exactly one optional file (`createAwsSqsOps`). Install the SDK
yourself if you use that helper:

```bash
pnpm add @aws-sdk/client-sqs
```

## Usage

`SqsQueueManager` is a `QueueManager`, passed via the `queueManagers` option (not
`watchers`). You give it the SQS operations port (`SqsOps`) and the queues to
expose — each with its source URL and DLQ URL:

```ts
import { SQSClient } from '@aws-sdk/client-sqs';
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { SqsQueueManager, createAwsSqsOps } from '@dudousxd/nestjs-telescope-sqs';

const client = new SQSClient({ region: 'us-east-1' });

@Module({
  imports: [
    TelescopeModule.forRoot({
      queueManagers: [
        new SqsQueueManager({
          ops: createAwsSqsOps(client),
          queues: [
            {
              name: 'mail',
              url: 'https://sqs.us-east-1.amazonaws.com/123456789012/mail',
              dlqUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/mail-dlq',
            },
          ],
        }),
      ],
    }),
  ],
})
export class AppModule {}
```

`createAwsSqsOps(client)` is the default `SqsOps` implementation and the **only**
place the AWS SDK is imported. Advanced hosts can implement `SqsOps` themselves
(four methods: `approximateCounts`, `receiveDlq`, `redrive`, `queueArn`) and skip
the SDK dependency entirely.

## What surfaces

This adds an `sqs` driver to the live-queue endpoints (same authorizer as the
rest of the dashboard):

| Method & path | Returns |
|---------------|---------|
| `GET /telescope/api/queues/live` | `QueueSummary[]` including each SQS queue — counts derived from `GetQueueAttributes` (source visible → `waiting`, source in-flight → `active`, **DLQ visible → `failed`**); `delayed`/`completed`/`paused` are always `0` and `isPaused` is `false`. |
| `GET /telescope/api/queues/live/sqs/:queue/counts` | `QueueCounts` for one queue. |
| `GET /telescope/api/queues/live/sqs/:queue/jobs?state=failed` | A best-effort DLQ snapshot (see limits below). Any non-`failed` `state` returns an empty page. |
| `GET /telescope/api/queues/live/sqs/:queue/jobs/:id` | A `QueueJobDetail` for a snapshotted DLQ message (redacted `data`). |

DLQ message bodies pass through core redaction before they leave the server, so
secret-keyed fields (e.g. `password`, `token`) are masked — the same security
property as the BullMQ manager.

## DLQ-only limitations

SQS has **no "list all messages" primitive**. You can only:

- read queue-depth approximations (`GetQueueAttributes`), and
- `ReceiveMessage`, which temporarily *hides* the messages it returns.

So this manager is deliberately DLQ-only:

- **Only `failed` is browsable.** `listJobs` returns an empty page for
  `waiting`/`active`/`delayed`/`completed`/`paused` (these states simply can't be
  enumerated in SQS). The non-failed *counts* still show in the summary.
- **`listJobs('failed')` is a snapshot, not a drain.** It `ReceiveMessage`s up to
  10 DLQ messages with a short visibility timeout and **never deletes them** —
  they reappear for real consumers once the timeout elapses. There is no real
  pagination (`nextCursor` is always `null`); SQS returns an arbitrary batch.
- **`getJob` reads a short-lived cache.** Received SQS messages aren't refetchable
  by id, so the snapshot caches each message body so `getJob(id)` can return it.
  An id that wasn't in the most recent snapshot returns `null`.
- **No `retry`/`remove`/`promote`/`retryAll`.** SQS has no per-message requeue.
  The single mutation is `redrive`.

## Redrive (the one action)

`redrive(queue)` issues a native SQS `StartMessageMoveTask` with
`SourceArn = <dlqArn>` and `DestinationArn = <sourceArn>`, moving the DLQ's
messages back to the source queue, and returns the best-effort pre-redrive failed
count. It surfaces as:

| Method & path | Effect |
|---------------|--------|
| `POST /telescope/api/queues/live/sqs/:queue/actions/redrive` | Start a DLQ → source message-move task; responds `{ ok: true, count }` (the pre-action DLQ count). |

### Gated by `authorizeAction` (default-deny)

Like all queue mutations, `redrive` runs behind the `TelescopeActionGuard` *on top
of* the read `authorizer`, and that guard **fails closed**: without an
`authorizeAction` callback, the redrive endpoint returns `403` even for callers
the read authorizer already trusts. Opt in explicitly:

```ts
TelescopeModule.forRoot({
  authorizer: (ctx) => isAdmin(ctx.request),
  authorizeAction: (ctx, action) => {
    // action: { driver: 'sqs', queue, action: 'redrive' }
    return canRedriveQueues(ctx.request);
  },
  queueManagers: [new SqsQueueManager({ ops: createAwsSqsOps(client), queues })],
});
```

> **Native redrive prerequisite.** `StartMessageMoveTask` requires the DLQ to have
> been configured as a redrive *target* (i.e. the source queue's redrive policy
> points at it). If your DLQ isn't set up for native redrive, the fallback is a
> manual receive → re-send → delete loop against the source queue; this package
> implements the native command as the default and does not ship the manual
> fallback.

## Testing — no real AWS

Unlike the BullMQ manager (which has a real-Redis integration test), there is **no
real-AWS integration test** here: SQS has no free local analog in this repo. The
manager depends only on the `SqsOps` port, so the unit tests run AWS-free in CI
with a mock `SqsOps` — that mock-port contract *is* the test surface. A light
`aws-sqs-ops.spec.ts` mocks the SQS client's `send` to assert the right SDK
command instances and inputs are issued.
