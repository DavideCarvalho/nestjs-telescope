# @dudousxd/nestjs-telescope-bullmq

BullMQ job watcher for [`@dudousxd/nestjs-telescope`](../../README.md). Captures
every job (id, name, queue, outcome, duration, attempts) and correlates the
queries and exceptions a job emits to that job's batch.

## Install

```bash
pnpm add @dudousxd/nestjs-telescope-bullmq
```

Peer deps: `@dudousxd/nestjs-telescope`, `@nestjs/bullmq`, `bullmq`,
`@nestjs/common`, `@nestjs/core`, `reflect-metadata`.

## Usage

Add the watcher to `TelescopeModule`. No host wiring is required — the watcher
discovers your `@Processor` (`WorkerHost`) classes and instruments them
automatically.

```ts
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { BullMqJobWatcher } from '@dudousxd/nestjs-telescope-bullmq';

@Module({
  imports: [
    TelescopeModule.forRoot({
      watchers: [new BullMqJobWatcher({ slowMs: 1000 })],
    }),
    // ...your BullModule.registerQueue(...) and @Processor classes
  ],
})
export class AppModule {}
```

Each processed job becomes a `job` entry with `origin: 'queue'`. Queries and
exceptions emitted while the job runs share the job's `batchId`, so opening a
job in the dashboard shows everything it caused.

With these entries captured, the core endpoint
`GET /telescope/api/queues?window=1h` reports per-queue throughput, runtime and
wait-time percentiles, and failure rate (wait time = `processedOn − enqueue`).

## Live queue reads (`BullMqQueueManager`)

The watcher above records *what jobs did*. `BullMqQueueManager` is the
complementary read side: it browses your queues' **current** state directly via
the BullMQ `Queue` API (counts, paused flag, and the jobs sitting in each list),
so the dashboard can show live queue depth and inspect individual jobs.

It is a `QueueManager`, passed via the `queueManagers` option (not `watchers`).
At bootstrap it discovers every `@nestjs/bullmq` `Queue` instance in the Nest
container through `DiscoveryService` (duck-typed — no extra wiring):

```ts
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { BullMqQueueManager } from '@dudousxd/nestjs-telescope-bullmq';

@Module({
  imports: [
    TelescopeModule.forRoot({
      queueManagers: [new BullMqQueueManager()],
    }),
    BullModule.forRoot({ connection }),
    BullModule.registerQueue({ name: 'mail' }),
  ],
})
export class AppModule {}
```

Pass an explicit allow-list to expose only some queues:
`new BullMqQueueManager(['mail', 'reports'])`.

This surfaces these read endpoints on the core controller, under the **existing
Telescope authorizer** (same gate as the rest of the dashboard):

| Method & path | Returns |
|---------------|---------|
| `GET /telescope/api/queues/live` | `{ queues: QueueSummary[] }` across all drivers — name, per-state counts, `isPaused`. |
| `GET /telescope/api/queues/live/bullmq/:queue/counts` | `QueueCounts` for one queue. |
| `GET /telescope/api/queues/live/bullmq/:queue/jobs?state=&cursor=&limit=` | A `JobPage` of jobs in `state` (`waiting`/`active`/`delayed`/`failed`/`completed`/`paused`); `nextCursor` paginates. |
| `GET /telescope/api/queues/live/bullmq/:queue/jobs/:id` | A `QueueJobDetail` (adds redacted `data`, `opts`, `stacktrace`, `returnValue`). |

Job payloads (`data`) are passed through core redaction before they leave the
server, so secret-keyed fields (e.g. `password`, `token`) are masked.

## Queue actions (mutations)

`BullMqQueueManager` also implements the action side of the `QueueManager` SPI —
`retry`, `remove`, `promote`, and `retryAll` — backed by the real BullMQ
`Job.retry()` / `Job.remove()` / `Job.promote()` and `Queue.retryJobs()` APIs.
These surface as **POST** endpoints on the core controller:

| Method & path | Effect |
|---------------|--------|
| `POST /telescope/api/queues/live/bullmq/:queue/jobs/:id/retry` | Re-queue a failed (or completed) job. |
| `POST /telescope/api/queues/live/bullmq/:queue/jobs/:id/remove` | Delete a job. |
| `POST /telescope/api/queues/live/bullmq/:queue/jobs/:id/promote` | Promote a delayed job to run now. |
| `POST /telescope/api/queues/live/bullmq/:queue/actions/retry-all?state=failed` | Bulk re-queue every job in `state`; responds `{ ok: true, count }` (the pre-action count). |

`redrive` is **SQS-only** and is not implemented by `BullMqQueueManager`; calling
`.../actions/redrive` against the bullmq driver returns `405 Method Not Allowed`.

### Enabling mutations — `authorizeAction` (default-deny)

Mutations are **denied by default**. They run behind a second guard
(`TelescopeActionGuard`) on top of the read `authorizer`, and that guard fails
closed: **without an `authorizeAction` callback, every mutation endpoint returns
`403`** — even for callers the read `authorizer` already trusts. Opt in by
supplying `authorizeAction` on `TelescopeModule.forRoot`:

```ts
TelescopeModule.forRoot({
  // Reads (browse queues/jobs) — the existing gate:
  authorizer: (ctx) => isAdmin(ctx.request),
  // Mutations (retry/remove/promote/retry-all) — separate, default-deny:
  authorizeAction: (ctx, action) => {
    // action: { driver, queue, action, jobId?, state? }
    return canMutateQueues(ctx.request);
  },
  queueManagers: [new BullMqQueueManager()],
});
```

`authorizeAction` receives the same `AuthorizerContext` plus a typed
`QueueActionRequest` describing the requested mutation. Returning a falsy value —
or throwing — denies the request (`403`). Keep it strictly narrower than your
read gate: browsing a queue should not imply the right to drain it.

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `slowMs` | `1000` | Jobs taking at least this long get a `slow` tag. |
| `includeJobData` | `true` | Capture `job.data` as the entry payload (core redaction still applies). |
| `clock` | wall clock | Injectable time source (for tests). |

## Not included

This watcher captures per-job entries; the aggregate queue metrics above are
computed in core from those entries (`GET /telescope/api/queues`). Broader health
rollups — N+1 insights, slowest request/query/job, top exceptions, and a visual
dashboard — are the concern of `@dudousxd/nestjs-telescope-pulse` and
`@dudousxd/nestjs-telescope-ui`, not this watcher.
