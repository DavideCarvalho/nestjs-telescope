# @dudousxd/nestjs-telescope-redis-watcher

Redis command watcher for [`@dudousxd/nestjs-telescope`](../../README.md).
Captures every command issued through a wrapped [`ioredis`](https://github.com/redis/ioredis)
client and records one `redis` entry per command
(`{ command, args, durationMs }`), correlated to the request or job that issued
it.

Every ioredis command funnels through `client.sendCommand(command)`. The watcher
monkey-patches that method on the client instance, captures the command name +
args, times the round-trip, and records the entry. The original is always called
and its result returned/thrown unchanged — recording failures are swallowed so a
telescope error can never alter a command's outcome.

## Install

```sh
pnpm add @dudousxd/nestjs-telescope-redis-watcher
```

`ioredis` is an **optional** peer dependency — you already have it if your app
uses Redis. If the client lacks `sendCommand`, the watcher no-ops; it never
throws.

## Usage

Two construction forms are supported.

```ts
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { RedisCommandWatcher } from '@dudousxd/nestjs-telescope-redis-watcher';

// 1. Wrap a client you already hold:
TelescopeModule.forRoot({
  watchers: [new RedisCommandWatcher(ioredisClient)],
});

// 2. Resolve the client lazily inside register():
TelescopeModule.forRoot({
  watchers: [
    new RedisCommandWatcher({
      instrument: (use, ctx) => {
        use(ctx.moduleRef.get('REDIS_CLIENT', { strict: false }));
      },
    }),
  ],
});
```

Each captured entry has type `redis` and `RedisContent`:

```ts
{
  command: string;          // uppercased command name, e.g. 'GET'
  args: unknown[];          // keys and shaping arguments; values are '[REDACTED]'
  durationMs: number | null; // round-trip time, null when unmeasurable
}
```

## Values are redacted by default

An entry keeps the command, its keys and the arguments that only shape it (TTLs,
flags, ranges, counts); every value is recorded as `[REDACTED]` in its place, and
replies are never recorded. `SET sess:abc <session json> EX 7200` is recorded as
`['sess:abc', '[REDACTED]', 'EX', 7200]`; `AUTH`, `HELLO`, `CONFIG` and `MIGRATE`
have every argument redacted.

To record values verbatim:

```ts
new RedisCommandWatcher(ioredisClient, { recordValues: true });
```

> **Warning:** with `recordValues: true`, whatever your app keeps in redis lands
> in the telemetry as is: sessions (csrf secrets, refresh tokens), cached user
> records, one-time codes. The core's key-based redaction cannot help, since
> redis arguments are bare strings with no key names.

## Caveat: shared clients

The watcher records exactly what the wrapped client does. If you share one
`ioredis` client with Telescope's own Redis storage provider, those storage
commands would be captured too. Pass a **dedicated/observed** client to the
watcher to avoid that noise.

## License

MIT © Davi Carvalho
