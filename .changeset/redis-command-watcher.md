---
'@dudousxd/nestjs-telescope-redis-watcher': minor
---

Add `@dudousxd/nestjs-telescope-redis-watcher` — `RedisCommandWatcher`, a watcher
that monkey-patches an `ioredis` client's `sendCommand` to capture every command
as a `redis` entry (`{ command, args, durationMs }`), correlated to the request
or job that issued it, restoring the original on cleanup. Supports both
`new RedisCommandWatcher(client)` and a `{ instrument }` form. `ioredis` is an
optional peer; the watcher no-ops when the client lacks `sendCommand`.
