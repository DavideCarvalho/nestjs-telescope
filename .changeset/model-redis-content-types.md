---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
---

Add the `model` and `redis` entry types (`EntryType.Model` / `EntryType.Redis`)
and their content shapes `ModelContent { action, entity, id, changes }` and
`RedisContent { command, args, durationMs }`, consumed by the new
`@dudousxd/nestjs-telescope-mikro-orm-watcher` and
`@dudousxd/nestjs-telescope-redis-watcher`. The UI gains Models/Redis nav types,
`ModelBody` / `RedisBody` detail renderers, and table summaries
(`<action> <entity>#<id>` for model, `<COMMAND> <args-preview>` for redis).
