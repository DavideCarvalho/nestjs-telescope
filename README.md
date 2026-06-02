# nestjs-telescope

> Laravel Telescope, redesigned for NestJS. Watch every request, query, job,
> email, and exception — correlated under one batch, non-blocking, pluggable,
> and safe in production.

**Status:** early development (`0.0.0`). See [`DESIGN.md`](./DESIGN.md) for the
architecture and [`PRODUCT.md`](./PRODUCT.md) for the product brief.

```ts
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { MikroOrmTelescope } from '@dudousxd/nestjs-telescope-mikro-orm';

@Module({
  imports: [
    TelescopeModule.forRoot({
      // dev: rich capture, open gate. prod: flip enabled, add authorizer + redact.
      enabled: process.env.NODE_ENV !== 'production',
      storage: MikroOrmTelescope.storage(),
      watchers: [
        TelescopeModule.requestWatcher(),
        TelescopeModule.exceptionWatcher(),
        TelescopeModule.jobWatcher(),
        TelescopeModule.mailWatcher(),
        MikroOrmTelescope.queryWatcher(),
      ],
      prune: { after: '24h' },
    }),
  ],
})
export class AppModule {}
```

Open `/telescope` (with the optional `@dudousxd/nestjs-telescope-ui`) and click a
request to see the exact queries, jobs, and exceptions it produced.

## Packages

| Package | What it is |
|---------|------------|
| `@dudousxd/nestjs-telescope` | Core: watchers (request/job/exception/mail), recorder, ALS correlation, SQLite store, headless API |
| `@dudousxd/nestjs-telescope-mikro-orm` | MikroORM query watcher + storage |
| `@dudousxd/nestjs-telescope-typeorm` | TypeORM query watcher + storage |
| `@dudousxd/nestjs-telescope-prisma` | Prisma query watcher + storage |
| `@dudousxd/nestjs-telescope-redis` | Shared, TTL-pruned storage for multi-instance production |
| `@dudousxd/nestjs-telescope-otel` | Bidirectional OpenTelemetry bridge |
| `@dudousxd/nestjs-telescope-ui` | Optional dashboard SPA |
| `@dudousxd/nestjs-telescope-testing` | In-memory store + watcher test harness |

## License

MIT © Davi Carvalho
