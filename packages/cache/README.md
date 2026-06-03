# @dudousxd/nestjs-telescope-cache

Cache watcher for [`@dudousxd/nestjs-telescope`](../../README.md). Captures cache
hits and misses, correlated to the request or job that issued them.

It supports two modes:

- **Official caches (default)** — pass a `cache-manager` (`@nestjs/cache-manager`)
  `Cache` and the watcher **auto-patches** its `get`/`set`. Zero wiring.
- **Custom caches** — pass `{ instrument }` and wire your own cache's native
  events (e.g. [BentoCache](https://bentocache.dev)) into Telescope yourself.

The philosophy: official libraries are auto-instrumented out of the box; any
other cache is made instrumentable through the `instrument` hook — Telescope
never has to special-case every cache library to support it.

Both modes record in the caller's async context, so each captured entry lands in
the active request/job batch automatically. No batch is opened here.

## Install

```sh
pnpm add @dudousxd/nestjs-telescope-cache
```

The cache type is structural (`get(key)` / `set(key, value, ttl?)`), so any
`cache-manager` v5 / `@nestjs/cache-manager` `Cache` satisfies it without a hard
dependency.

## Usage — official cache (auto-patch)

Inject the `cache-manager` `Cache` and register the watcher. The watcher patches
its `get`/`set` for you; patching is per-instance and idempotent.

```ts
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { CacheWatcher } from '@dudousxd/nestjs-telescope-cache';
import type { Cache } from 'cache-manager';

TelescopeModule.forRootAsync({
  inject: [CACHE_MANAGER],
  useFactory: (cache: Cache) => ({
    watchers: [new CacheWatcher(cache)],
  }),
});
```

## Usage — custom cache (`instrument`)

A cache that isn't a `cache-manager`-style `Cache` (e.g. BentoCache) won't be
auto-patched. Instead, pass a `CustomCacheSource` — an object with an
`instrument(emit, ctx)` hook. The watcher calls `instrument` **once** at
registration; you resolve your cache from `ctx.moduleRef`, subscribe to its
native events, and call `emit({ operation, key, hit })` for each. Nothing is
patched — your subscription owns the wiring.

```ts
emit({ operation: 'get' | 'set', key: string, hit?: boolean | null });
// reads: hit = true/false; writes: hit = null (or omit it)
```

`emit` reuses the same recording path as the auto-patch mode, so custom events
get identical family-hash/tags/correlation and recording failures are swallowed
the same way (your `emit` call never throws on a Telescope error).

### BentoCache example

```ts
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { CacheWatcher } from '@dudousxd/nestjs-telescope-cache';
import { BentoCache } from 'bentocache';

TelescopeModule.forRootAsync({
  useFactory: () => ({
    watchers: [
      new CacheWatcher({
        instrument: (emit, ctx) => {
          // Resolve your BentoCache instance from the Nest container.
          const bento = ctx.moduleRef.get<BentoCache<never>>(BentoCache, {
            strict: false,
          });

          // Subscribe to BentoCache's native bus events and forward them.
          bento.on('cache:hit', ({ key }) => {
            emit({ operation: 'get', key, hit: true });
          });
          bento.on('cache:miss', ({ key }) => {
            emit({ operation: 'get', key, hit: false });
          });
          bento.on('cache:written', ({ key }) => {
            emit({ operation: 'set', key });
          });
        },
      }),
    ],
  }),
});
```

Because `emit` records in the caller's async context, each event lands in the
request/job batch that triggered the cache operation — just like the auto-patch
path.

Each captured entry has type `cache` and `CacheContent`:

```ts
{
  operation: 'get' | 'set';
  key: string;
  hit: boolean | null; // get: true/false (hit vs miss); set: null (n/a)
}
```

`get` returns the cached value unchanged and records `hit: true` when the value
is neither `undefined` nor `null`. `set` records `hit: null`. Errors from the
underlying cache are always re-thrown; recording failures are swallowed so a
telescope error can never alter the cache's outcome.

## License

MIT © Davi Carvalho
