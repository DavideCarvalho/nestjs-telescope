---
"@dudousxd/nestjs-telescope": minor
"@dudousxd/nestjs-telescope-schedule": minor
"@dudousxd/nestjs-telescope-ui": minor
---

Surface whether a scheduled cron is currently active. `ScheduledTask` gains a
`running: boolean | null` field; the `@nestjs/schedule` watcher reads the
`CronJob.running` flag (null for intervals/timeouts, which expose no state), and
the Schedules console renders an Active/Stopped badge plus an active/stopped
summary so a registered-but-stopped cron is obvious at a glance.
