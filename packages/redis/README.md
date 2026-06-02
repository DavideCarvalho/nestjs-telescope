# @dudousxd/nestjs-telescope-redis

> Redis-backed shared storage provider for
> [@dudousxd/nestjs-telescope](https://github.com/DavideCarvalho/nestjs-telescope).
> Lets every replica read and write the same Telescope store, so the dashboard
> shows entries from the whole cluster instead of one process.

**Status:** early development (`0.0.0`). Requires Redis 6+ and `ioredis` v5+.

## Install

```sh
pnpm add @dudousxd/nestjs-telescope-redis ioredis
```

## Usage

Construct the provider with an `ioredis` client and hand it to
`TelescopeModule.forRoot` as the `storage` option:

```ts
import Redis from 'ioredis';
import { RedisStorageProvider } from '@dudousxd/nestjs-telescope-redis';
import { TelescopeModule } from '@dudousxd/nestjs-telescope';

const storage = new RedisStorageProvider(new Redis(process.env.REDIS_URL));

TelescopeModule.forRoot({ storage });
```

## Notes

- **Multi-instance.** All replicas pointed at the same Redis share one store, so
  the dashboard aggregates entries across the whole deployment — the reason to
  pick this over the default per-process SQLite store.
- **The host owns the connection.** The provider never closes the `ioredis`
  client it was given; `close()` is a no-op. Manage the connection's lifecycle
  (and `quit()`) yourself.
- **Pruning is explicit.** There is no per-key TTL — old entries are removed by
  the core pruner via the `prune` config (e.g. `prune: { after: '24h' }`), which
  calls the provider's `prune`.
- **`keyPrefix` option.** Every Telescope key is namespaced; the default prefix
  is `telescope:`. Override it to share one Redis across apps:

  ```ts
  new RedisStorageProvider(redis, { keyPrefix: 'myapp:telescope:' });
  ```

## License

MIT © Davi Carvalho
