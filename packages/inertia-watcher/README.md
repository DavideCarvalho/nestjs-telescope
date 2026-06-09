# @dudousxd/nestjs-telescope-inertia-watcher

Inertia.js render watcher for [`@dudousxd/nestjs-telescope`](../../README.md).
Subscribes to the `nestjs-inertia:render` diagnostics channel that
[`@dudousxd/nestjs-inertia`](https://github.com/DavideCarvalho/nestjs-inertia)
publishes once per response, and records one `inertia` entry per render
(rendered component, resolved props, deferred/merge classification, the
partial-reload decision, asset version + 409 version-mismatch, history flags and
page size), correlated to the request that produced it.

The bridge is Node's core `node:diagnostics_channel` — telescope **subscribes**,
inertia **publishes**. The two libraries stay fully decoupled: this package does
NOT depend on `nestjs-inertia`. The channel name (`nestjs-inertia:render`) and
the payload shape (`v: 1`) are the only contract; malformed or wrong-version
messages are dropped, never thrown.

When this watcher isn't installed, inertia's `channel.hasSubscribers` stays
`false` and it publishes nothing — so the integration costs ~zero when off.

## Install

```sh
pnpm add @dudousxd/nestjs-telescope-inertia-watcher
```

## Usage

```ts
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { InertiaWatcher } from '@dudousxd/nestjs-telescope-inertia-watcher';

TelescopeModule.forRoot({
  watchers: [new InertiaWatcher()],
});
```

On bootstrap the watcher subscribes to the channel (flipping inertia's
`hasSubscribers` to `true`), so events start flowing. Each captured entry has
type `inertia` and `InertiaContent`. The heavy `resolvedProps` field is passed
to the Recorder by reference, so its `redactBounded` clips + masks it with the
same budget every other entry's content gets (secret keys → `[REDACTED]`,
oversized trees truncated).

## License

MIT © Davi Carvalho
