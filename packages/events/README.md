# @dudousxd/nestjs-telescope-events

Event watcher for [`@dudousxd/nestjs-telescope`](../../README.md). Captures every
event emitted through [`@nestjs/event-emitter`](https://docs.nestjs.com/techniques/events)'s
`EventEmitter2`, correlated to the request or job that emitted it.

The watcher attaches a single wildcard listener (`emitter.onAny(...)`) to the
app's `EventEmitter2` singleton and records one `event` entry per emit. Because
the listener runs in the emitter's async context, each captured entry lands in
the active request/job batch automatically. No batch is opened here.

## Install

```sh
pnpm add @dudousxd/nestjs-telescope-events
```

`@nestjs/event-emitter` and `eventemitter2` are **optional** peer dependencies —
you already have them if your app emits events. If `EventEmitter2` can't be
resolved (or has no `onAny`), the watcher logs a warning and no-ops; it never
throws.

## Usage

Add the watcher to your Telescope config. It resolves `EventEmitter2` from the
Nest container itself — no wiring needed.

```ts
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { EventsWatcher } from '@dudousxd/nestjs-telescope-events';

TelescopeModule.forRoot({
  watchers: [new EventsWatcher()],
});
```

Make sure `EventEmitterModule.forRoot()` is registered in your app (it is, if you
use `@nestjs/event-emitter`).

Each captured entry has type `event` and `EventContent`:

```ts
{
  name: string;          // String(event)
  payload: unknown;      // the single emitted value, or the array of values
  listenerCount: number | null; // listeners attached at emit time
}
```

`payload` is redacted by the Recorder like any other content. When a wildcard
namespace event is emitted with several values, `payload` is the array of those
values; with a single value it's that value unwrapped.

## License

MIT © Davi Carvalho
