---
'@dudousxd/nestjs-telescope-mikro-orm-watcher': minor
---

Add `@dudousxd/nestjs-telescope-mikro-orm-watcher` — `MikroOrmModelWatcher`, a
watcher that registers a MikroORM `EventSubscriber` on the EntityManager's event
manager and records every entity lifecycle change (create / update / delete) as
a `model` entry (`{ action, entity, id, changes }`), correlated to the request or
job that triggered the flush. Telescope's own storage entities are skipped to
avoid a feedback loop. `@mikro-orm/core` is an optional peer; the watcher
degrades to a no-op when MikroORM is absent.
