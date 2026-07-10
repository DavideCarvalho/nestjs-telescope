---
"@dudousxd/nestjs-telescope": minor
---

Auto-collect `ScheduleManager`/`QueueManager` instances from `watchers`, and add
`telescopeMountPaths()`.

A watcher that implements the `ScheduleManager` SPI (e.g. `ScheduleWatcher`,
which implements both `Watcher` and `ScheduleManager`) used to also need to be
listed explicitly in `scheduleManagers` — forgetting one of the two arrays left
`/schedules/live` silently empty even though the watcher itself was registered
and working. `ScheduleManagerRegistry` and `QueueManagerRegistry` now also scan
`watchers` and auto-register any entry that structurally implements the
respective SPI (`ScheduleManager`: `listTasks`; `QueueManager`: `driver`,
`init`, `listQueues`, `counts`, `listJobs`, `getJob`). A watcher instance listed
in both arrays is inited exactly once (deduped by identity); the explicit
`scheduleManagers`/`queueManagers` arrays keep working unchanged for standalone
managers that aren't watchers.

Also adds `telescopeMountPaths(path = 'telescope')`, a small helper for hosts
using `setGlobalPrefix` — returns the route roots to exclude
(`app.setGlobalPrefix('api', { exclude: telescopeMountPaths() })`), normalized
the same way the module normalizes its own mount `path`.
