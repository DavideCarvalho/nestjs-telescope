# @dudousxd/nestjs-telescope-cache

Cache watcher for [`@dudousxd/nestjs-telescope`](../../README.md). Wraps a
`cache-manager` (`@nestjs/cache-manager`) `Cache` instance's `get`/`set` to
capture cache hits and misses, correlated to the request or job that issued
them.

Both operations run in the caller's async context, so each captured entry lands
in the active request/job batch automatically. No batch is opened here.

## Install

```sh
pnpm add @dudousxd/nestjs-telescope-cache
```

The cache type is structural (`get(key)` / `set(key, value, ttl?)`), so any
`cache-manager` v5 / `@nestjs/cache-manager` `Cache` satisfies it without a hard
dependency.

## Usage

Inject the cache and register the watcher:

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
