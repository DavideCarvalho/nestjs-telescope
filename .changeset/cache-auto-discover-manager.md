---
'@dudousxd/nestjs-telescope-cache': minor
---

Add zero-config auto-discovery to `CacheWatcher`. `new CacheWatcher()` (no args)
now resolves the standard `@nestjs/cache-manager` `CACHE_MANAGER` from the Nest
container (`ctx.moduleRef.get(CACHE_MANAGER, { strict: false })`) and patches its
`get`/`set` automatically — no manual resource wiring. If `CACHE_MANAGER` isn't
found (or isn't a `get`/`set` cache), it logs a warning and no-ops, never throws.
The explicit `new CacheWatcher(cache)` and `{ instrument }` forms still work
unchanged as overrides/escape hatches.
