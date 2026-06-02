# @dudousxd/nestjs-telescope-schedule

Schedule watcher for [`@dudousxd/nestjs-telescope`](../../README.md). Wraps
[`@nestjs/schedule`](https://docs.nestjs.com/techniques/task-scheduling)
`@Cron`/`@Interval`/`@Timeout` handlers so each run opens a `'schedule'` batch —
correlating the queries and exceptions that scheduled task emits to it — and
records a job entry for the run itself (outcome + duration).

## Install

```sh
pnpm add @dudousxd/nestjs-telescope-schedule
```

Peers: `@nestjs/schedule` >= 4, `@nestjs/common`/`@nestjs/core` >= 10.

## Usage

```ts
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { ScheduleWatcher } from '@dudousxd/nestjs-telescope-schedule';

@Module({
  imports: [
    // Import Telescope BEFORE ScheduleModule (see ordering note below).
    TelescopeModule.forRoot({ watchers: [new ScheduleWatcher({ slowMs: 1000 })] }),
    ScheduleModule.forRoot(),
  ],
})
export class AppModule {}
```

## How it works

At registration the watcher uses NestJS `DiscoveryService` + `MetadataScanner`
to find every provider method carrying a `@nestjs/schedule` metadata key
(`SCHEDULER_TYPE` / `SCHEDULE_CRON_OPTIONS` / `SCHEDULE_INTERVAL_OPTIONS` /
`SCHEDULE_TIMEOUT_OPTIONS`) and prototype-patches it with a wrapper that runs the
original inside `ctx.runInBatch('schedule', ...)`.

Entries are recorded as **`EntryType.Job`** (a scheduled task *is* a job; the
`'schedule'` batch origin distinguishes it from a queue job). The watcher's own
`type` is the string **`'schedule'`** so it surfaces distinctly in `/meta`. Each
recorded entry has `JobContent` with `queue: 'schedule'`, the scheduler name
(`@Cron({ name })`, else the method name), `status: 'completed' | 'failed'`,
`durationMs`, and a `schedule:<cron|interval|timeout>` tag.

On failure it records a `failed` entry and re-throws so `@nestjs/schedule`'s own
error handling is untouched. Recording failures are swallowed — a telescope
error can never break a scheduled task.

## Ordering caveat

`@nestjs/schedule`'s explorer captures each handler reference at its own
`onModuleInit`. For the prototype patch to take effect, **Telescope's module must
initialize before `ScheduleModule`** (import it first / higher in the module
tree). If `ScheduleModule` initializes first it will have bound the un-wrapped
handler and that task won't be captured (the watcher logs a "no scheduled
methods found" warning only when nothing matched at all).

## License

MIT © Davi Carvalho
