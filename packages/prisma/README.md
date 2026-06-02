# @dudousxd/nestjs-telescope-prisma

Prisma query watcher for [`@dudousxd/nestjs-telescope`](../../README.md).
Captures every SQL statement Prisma executes (SQL + duration + params) for a
full query log and slow-query visibility.

## Usage

The host must construct `PrismaClient` with query event logging enabled, then
pass the client to the watcher:

```ts
import { PrismaClient } from '@prisma/client';
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { PrismaQueryWatcher } from '@dudousxd/nestjs-telescope-prisma';

const prisma = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });

TelescopeModule.forRoot({ watchers: [new PrismaQueryWatcher(prisma)] });
```

At registration the watcher subscribes via `prisma.$on('query', ...)`. The
`log: [{ emit: 'event', level: 'query' }]` config is **required** — without it
Prisma never emits query events and nothing is recorded.

You can tag slow queries with a custom threshold (default 1000ms):

```ts
new PrismaQueryWatcher(prisma, { slowMs: 500 });
```

## ⚠️ Caveat: no request/job correlation

This is a real **Prisma engine limitation**, not a bug in this adapter.

Prisma's `prisma.$on('query', cb)` fires the event **detached from the caller's
async context** — the query engine emits query events on its own channel, after
the fact. So when this watcher records a query, there is no active request/job
batch to attach it to:

- Captured query entries are **orphaned**: they do NOT correlate to the request
  or job that issued them.
- **N+1 detection won't apply** to Prisma queries — it's a per-batch heuristic,
  and these queries have no batch.

The queries are captured anyway because they remain valuable on their own: a
full query log plus slow-query visibility.

**Contrast:** the
[MikroORM](../mikro-orm/README.md) and [TypeORM](../typeorm/README.md) adapters
DO correlate each query to its request/job batch, because their loggers run
inside the query's async context (via AsyncLocalStorage). If per-request query
correlation matters to you, prefer one of those.
