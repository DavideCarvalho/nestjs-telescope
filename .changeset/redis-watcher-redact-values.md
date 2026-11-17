---
'@dudousxd/nestjs-telescope-redis-watcher': minor
---

Security fix: the redis watcher no longer records command values. A command keeps its name, its keys and the arguments that only shape it (TTLs, flags, ranges, counts); every value argument (what `SET`/`HSET`/`LPUSH`/`PUBLISH`… write, a script's `ARGV`, `AUTH`/`HELLO`/`CONFIG` arguments) is recorded as `[REDACTED]` in its place, and replies are never recorded. Before, `SET <session-key> <session json>` put session secrets (csrf secret, refresh tokens) into the telemetry verbatim.

This changes what is recorded, not the API. To record values as before, opt in with `new RedisCommandWatcher(client, { recordValues: true })`, and only for a client that holds nothing sensitive. `redactRedisArgs` and `REDIS_REDACTED` are exported.
