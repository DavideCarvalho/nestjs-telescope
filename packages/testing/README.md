# @dudousxd/nestjs-telescope-testing

Test utilities for [`@dudousxd/nestjs-telescope`](https://github.com/DavideCarvalho/nestjs-telescope).

## Install

```bash
pnpm add -D @dudousxd/nestjs-telescope-testing
```

## `FakeClock`

A deterministic clock you can pass as the `now` option to `Recorder`.

```ts
import { FakeClock } from '@dudousxd/nestjs-telescope-testing';

const clock = new FakeClock(0);
clock.now();        // 0
clock.advance(500); // move forward 500 ms
clock.now();        // 500
clock.set(1000);    // jump to absolute ms
clock.now();        // 1000
```

## `collectWatcherEntries`

Registers a `Watcher` against a minimal capturing `WatcherContext` and returns everything it recorded — no NestJS app required.

```ts
import { collectWatcherEntries } from '@dudousxd/nestjs-telescope-testing';
import type { Watcher, WatcherContext } from '@dudousxd/nestjs-telescope';

const myWatcher: Watcher = {
  type: 'demo',
  register(ctx: WatcherContext) {
    ctx.record({ type: 'demo', content: { hello: 'world' } });
  },
};

const { recorded, context } = await collectWatcherEntries(myWatcher);
// recorded[0] => { type: 'demo', content: { hello: 'world' } }

// You can also drive batch handles:
const handle = context.beginBatch('manual');
// handle.id => 'batch-0'
handle.end();
```

## `InMemoryStorageProvider` (re-export)

`@dudousxd/nestjs-telescope-testing` re-exports `InMemoryStorageProvider` from core so tests only need one import.

```ts
import { InMemoryStorageProvider } from '@dudousxd/nestjs-telescope-testing';

const storage = new InMemoryStorageProvider();
```
