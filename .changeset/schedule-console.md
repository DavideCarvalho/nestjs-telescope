---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-schedule': minor
'@dudousxd/nestjs-telescope-ui': minor
---

Add a live Schedule console for `@nestjs/schedule` scheduled tasks, mirroring the
Queues console.

Core gains a `ScheduleManager` SPI (`ScheduledTask` = name, kind, schedule,
nextRunAt, lastRunAt, lastDurationMs, lastStatus), a `ScheduleManagerRegistry`
that boots the configured managers, a `scheduleManagers?` option, and a
read-guarded `GET /telescope/api/schedules/live` returning `{ tasks }`.

The `@nestjs/schedule` watcher now also implements `ScheduleManager`: its
`listTasks()` reads `SchedulerRegistry` (via `moduleRef`) for the registered
cron/interval/timeout names, cron expression and next fire time, and merges its
own in-memory last-run map (additive to the existing entry-recording path). It
degrades gracefully — a missing/partial registry yields a null-filled or empty
list and never throws.

The UI adds a read-only `#/schedules` page (a table of name, kind, schedule,
next run, last run, duration, status) that polls like the queues console and
honors the live-tail pause, a `schedulesLive()` client method + `useSchedulesLive()`
hook, and a "Schedules" sidebar console link (distinct from the per-type
Schedule entries tab).
