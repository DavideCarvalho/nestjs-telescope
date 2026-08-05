---
'@dudousxd/nestjs-telescope-bullmq': minor
'@dudousxd/nestjs-telescope-schedule': minor
---

Fix a silent, total instrumentation failure: BullMQ jobs and `@nestjs/schedule` runs were never captured in a real app.

Both watchers instrumented by replacing a method on the provider **prototype** during `register()`, which the registrar runs at `onApplicationBootstrap`. By then both frameworks have already captured the handler they will call forever — `@nestjs/bullmq` binds `instance['process']` at `BullRegistrar.onModuleInit`, and `ScheduleExplorer` closes over `instance[key]` at its own `onModuleInit`. Measured against real infrastructure: a real BullMQ worker processing a job produced **zero** telescope entries, and a real `@Cron` firing every second for ten seconds produced **zero**. Not just the exception — the `job`/`schedule` entry and the whole batch (trace) for that unit of work never happened. Importing Telescope before `ScheduleModule`, as the docs advised, did not change it.

Both now instrument at a seam the framework actually calls, installed when the watcher is **constructed** — before `NestFactory.create`, and therefore before either explorer:

- **BullMQ** hooks `ProcessorDecoratorService.decorate`, the framework's own processor-wrapping extension point, which sits on both the static branch (decorated once at `onModuleInit`) and the request-scoped branch (decorated per job). If the installed `@nestjs/bullmq` predates that seam, or the host replaced the provider, the watcher warns at boot with the version and falls back to re-pointing `worker.processFn`.
- **`@nestjs/schedule`** hooks `ScheduleExplorer.wrapFunctionInTryCatchBlocks`, the last point at which the raw handler is still in the framework's hands — so Telescope sees the throw before the framework's own try/catch swallows it, and the decorators' `SCHEDULER_*` metadata (which decides whether a task is scheduled at all) is untouched.

Each run now opens its own `queue`/`schedule` batch, entries recorded inside inherit its traceId, and a throw produces an `exception` entry in the same batch. Telescope failures still cannot change the host's behaviour: the handler always runs, its result and its throw pass through unchanged, and recording failures are swallowed.

Tests now use the real trigger: a real BullMQ worker draining a real queue against a real Redis (`REDIS_URL`, else a throwaway docker container), and a real `@Cron`/`@Interval` fired by `ScheduleModule` itself. `bullmq-job.watcher.integration.spec.ts` also stops passing `connection: { url: REDIS_URL }` — ioredis has no such option, so it had been silently connecting to `localhost:6379`.

No API change: the watchers are constructed and passed exactly as before, and the import-ordering advice for `ScheduleModule` is no longer needed.
