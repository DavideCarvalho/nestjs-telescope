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

> **Reads only (this phase).** Queue actions (retry / remove / promote / redrive)
> land in Phase 2; `BullMqQueueManager` exposes no mutating methods yet.

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
