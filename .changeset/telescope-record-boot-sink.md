---
"@dudousxd/nestjs-telescope": minor
"@dudousxd/nestjs-telescope-mikro-orm": minor
---

Add a first-class deferred record sink, `telescopeRecord`/`setTelescopeRecordSink`
(exported from core), mirroring `telescopeDump`'s pattern. It exists for
boot-time integrations — most notably a MikroORM query logger — that need to
emit Telescope entries before Nest DI has constructed `TelescopeService`:
MikroORM builds (and can start calling) its logger at `MikroORM.init()`, well
before `TelescopeModule` wires anything. `TelescopeService`'s constructor binds
the global sink automatically and `onApplicationShutdown` clears it; calls made
before binding (or after shutdown) are dropped, not buffered — there is no
unbounded queue waiting to replay boot noise.

This removes the need for host apps to hand-roll their own module-global
bridge (`let telescopeRecord; export function setTelescopeRecord()` filled in
from `onModuleInit`) just to wire the MikroORM logger before DI is ready.

`telescopeMikroOrmLogger`'s `record` parameter is now optional. When omitted,
the logger lazily resolves `telescopeRecord` from core at each `logQuery` call
(not at construction), so binding order no longer matters:

```ts
MikroORM.init({
  debug: ['query'],
  loggerFactory: telescopeMikroOrmLogger(),
});
```

An explicit `record` function, when passed, still takes precedence over the
global sink.
