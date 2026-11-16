---
'@dudousxd/nestjs-telescope': minor
---

Health checks, instance heartbeats and the fleet. `checks: [checks.redis({ client }), checks.terminus(name, fn), checks.custom(name, run)]` (cached, single-flight, timed out); `health: { probes: true }` mounts unauthenticated `GET <path>/api/probes/ready` (503 while a critical check is down or the instance drains) and `/live`. Every instance beats every 15 s (`fleet`: on for a control plane and a tenant, off for a standalone app unless `fleet: true`); a tenant's heartbeat rides its batches over every transport. `GET <path>/api/fleet` and the `telescope_get_fleet` MCP tool show per app the instances (up / starting / draining / gone), deploys with rollout progress, restart loops and failing checks with the exception families recorded since, scoped like every other read. New alert rules `instances-up`, `restart-loop`, `check-down` and `entries-dropped` raise and resolve per subject; their payloads carry `fleet` and `resolved`.
