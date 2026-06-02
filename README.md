# nestjs-telescope

> Laravel Telescope, redesigned for NestJS. Watch every request, query, job,
> email, and exception — correlated under one batch, non-blocking, pluggable,
> and safe in production. Works on Express **and** Fastify.

**Status:** early development (`0.0.0`). See [`DESIGN.md`](./DESIGN.md) for the
architecture and [`PRODUCT.md`](./PRODUCT.md) for the product brief.

## Quick start

Import the module. Request and exception capture is wired automatically; the
SQLite store and pruner are on by default.

```ts
import { TelescopeModule } from '@dudousxd/nestjs-telescope';

@Module({
  imports: [
    TelescopeModule.forRoot({
      // dev: rich capture, open gate. prod: flip enabled + supply an authorizer.
      enabled: process.env.NODE_ENV !== 'production',
      authorizer: () => true, // gates the API; defaults to deny in production
      prune: { after: '24h' },
    }),
  ],
})
export class AppModule {}
```

Hit `GET /telescope/api/entries` (or `/telescope/api/entries/:id` for a request
and everything it caused).

For queue health, `GET /telescope/api/queues?window=1h` returns per-queue
throughput, runtime and wait-time percentiles, and failure rate aggregated from
captured job entries.

For an at-a-glance health snapshot, `GET /telescope/api/pulse?window=1h` returns
per-type entry counts, the slowest entries, the most frequent exceptions, and
N+1 query occurrences — all aggregated from captured entries.

To capture outbound HTTP calls (correlated to the request/job that made them),
add the built-in `HttpClientWatcher` — it instruments the global `fetch`, no peer
dependency required, and sanitizes credentials/secret query params from captured
URLs:

```ts
import { TelescopeModule, HttpClientWatcher } from '@dudousxd/nestjs-telescope';

TelescopeModule.forRoot({ watchers: [new HttpClientWatcher({ slowMs: 1000 })] });
```

Capture queries from MikroORM by wiring its logger —
see [`packages/mikro-orm`](./packages/mikro-orm/README.md):

```ts
MikroOrmModule.forRootAsync({
  inject: [TelescopeService],
  useFactory: (telescope: TelescopeService) => ({
    // ...your config
    debug: ['query'],
    loggerFactory: telescopeMikroOrmLogger((input) => telescope.record(input)),
  }),
});
```

## Packages

| Package | Status | What it is |
|---------|--------|------------|
| `@dudousxd/nestjs-telescope` | ✅ shipped | Core: request + exception watchers, recorder, ALS correlation, SQLite store, headless API, guard, pruner |
| `@dudousxd/nestjs-telescope-mikro-orm` | ✅ shipped | MikroORM query watcher + N+1 detector |
| `@dudousxd/nestjs-telescope-bullmq` | ✅ shipped | BullMQ job watcher: per-job capture + query/exception correlation |
| `@dudousxd/nestjs-telescope-testing` | ✅ shipped | In-memory store re-export, `FakeClock`, watcher test harness |
| `@dudousxd/nestjs-telescope-typeorm` | planned | TypeORM query watcher |
| `@dudousxd/nestjs-telescope-prisma` | planned | Prisma query watcher (runtime `$on('query')`) |
| `@dudousxd/nestjs-telescope-redis` | planned | Shared, TTL-pruned storage for multi-instance production |
| `@dudousxd/nestjs-telescope-otel` | planned | Bidirectional OpenTelemetry bridge |
| `@dudousxd/nestjs-telescope-pulse` | planned | Aggregate health dashboard (Pulse-mode) + N+1 insights |
| `@dudousxd/nestjs-telescope-ui` | planned | Optional dashboard SPA |

## License

MIT © Davi Carvalho
