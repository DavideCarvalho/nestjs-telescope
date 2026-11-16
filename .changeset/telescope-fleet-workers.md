---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
'@dudousxd/nestjs-telescope-bullmq': minor
---

Workers in the fleet. Every heartbeat carries a `role`: `web` for a process serving HTTP (`NestFactory.create`), a worker's name for one without an HTTP server (`createApplicationContext`, a microservice). A worker reports once it has run `fleet.workerAfter` (`30s`), so a short command never becomes an instance, and is named after what marked it (`markFleetWorker('name')`; the BullMQ watcher marks `bullmq`) or `worker`; `fleet.role` names it and reports at once, and `fleet.report: ['web']` keeps workers out. Workers go through the same lifecycle (`ready`, `draining` on shutdown or SIGTERM/SIGINT, `gone`), run their health checks without an HTTP route, and send no `url`.

The fleet view gains `role` on instances, restart loops and `self`, and `roles` (counts per role, `web` first) per app; readiness reports the role. Restart loops are counted per host and role. `instances-up` counts web instances (an app with only workers counts its workers) and takes `role` (a worker's name, or `'*'`); the `instances` check state follows the same rule. A heartbeat without a role (an older tenant) is `web`; an older control plane ignores the field. The Fleet page shows a Role column and a role filter.
