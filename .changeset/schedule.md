---
'@dudousxd/nestjs-telescope-schedule': minor
---

Add the schedule watcher (`@dudousxd/nestjs-telescope-schedule`).
`ScheduleWatcher` discovers `@nestjs/schedule` `@Cron`/`@Interval`/`@Timeout`
handlers via `DiscoveryService` + `MetadataScanner` (matching on the
`SCHEDULER_TYPE`/`SCHEDULE_*_OPTIONS` metadata keys) and prototype-patches each so
every run opens a `'schedule'` batch — correlating the task's queries/exceptions
— and records a job entry (`EntryType.Job`, `queue: 'schedule'`) with
outcome/duration. The watcher's `type` is the string `'schedule'` so it surfaces
distinctly in `/meta`. Failures are re-thrown; recording is non-throwing.
Documents the bootstrap-ordering requirement (Telescope must initialize before
`ScheduleModule`).
