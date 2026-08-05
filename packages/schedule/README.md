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
    // Import order does not matter (see "Ordering" below).
    TelescopeModule.forRoot({ watchers: [new ScheduleWatcher({ slowMs: 1000 })] }),
    ScheduleModule.forRoot(),
  ],
})
export class AppModule {}
```

## How it works

Constructing the watcher patches `ScheduleExplorer.wrapFunctionInTryCatchBlocks`
— the last point at which `@nestjs/schedule` still holds the raw handler — so
every function the explorer hands to the scheduler already runs inside
`ctx.runInBatch('schedule', ...)`. `register()` then points that seam at the live
`WatcherContext`.

The decorators' metadata (`SCHEDULER_TYPE` / `SCHEDULE_CRON_OPTIONS` /
`SCHEDULE_INTERVAL_OPTIONS` / `SCHEDULE_TIMEOUT_OPTIONS`) is read by the explorer
from the original handler and is carried onto the wrapper as well, so wrapping
can never stop a task from being scheduled.

Entries are recorded as **`EntryType.Job`** (a scheduled task *is* a job; the
`'schedule'` batch origin distinguishes it from a queue job). The watcher's own
`type` is the string **`'schedule'`** so it surfaces distinctly in `/meta`. Each
recorded entry has `JobContent` with `queue: 'schedule'`, the scheduler name
(`@Cron({ name })`, else the method name), `status: 'completed' | 'failed'`,
`durationMs`, and a `schedule:<cron|interval|timeout>` tag.

On failure it records a `failed` entry and re-throws so `@nestjs/schedule`'s own
error handling is untouched. Recording failures are swallowed — a telescope
error can never break a scheduled task.

## Ordering

**No import ordering is required.** The seam is installed when the watcher is
constructed — while your `@Module` metadata is still being built, before
`NestFactory.create` and therefore before `ScheduleExplorer.onModuleInit`
whichever way round the imports go.

This used not to be true, and the version that claimed it was wrong: the watcher
patched provider prototypes at `onApplicationBootstrap`, by which time the
explorer had already closed over `instance[key]`, and a timer-driven `@Cron`
recorded nothing at all — importing Telescope first did not change that. If a
future `@nestjs/schedule` moves the seam, the watcher warns at boot with the
installed version and the fact that runs are not being captured, rather than
registering and silently recording nothing.

## License

MIT © Davi Carvalho
