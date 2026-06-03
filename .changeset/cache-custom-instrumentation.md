---
'@dudousxd/nestjs-telescope-cache': minor
---

Add a custom cache instrumentation path to `CacheWatcher`. The constructor now
accepts either a `cache-manager`-style `CacheLike` (auto-patches `get`/`set`, as
before — fully backward compatible) **or** a `CustomCacheSource`: an object with
an `instrument(emit, ctx)` hook. On the custom path the watcher patches nothing
and instead calls `instrument` once at `register()`, handing the host an `emit`
callback (and the `WatcherContext`) so it can resolve its own cache from
`ctx.moduleRef`, subscribe to that cache's native events (e.g. BentoCache's
`cache:hit` / `cache:miss` / `cache:written`), and forward them as
`{ operation, key, hit }` events. Emitted events reuse the same recording path —
identical family-hash/tags, request/job correlation, and swallowed recording
failures. Exports the new `CacheEventInput` and `CustomCacheSource` types.
