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
