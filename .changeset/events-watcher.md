---
'@dudousxd/nestjs-telescope-events': minor
---

Add `@dudousxd/nestjs-telescope-events` — `EventsWatcher`, a watcher that attaches
a wildcard listener to `@nestjs/event-emitter`'s `EventEmitter2` and records every
emitted event as an `event` entry (`{ name, payload, listenerCount }`), correlated
to the request/job that emitted it. `@nestjs/event-emitter`/`eventemitter2` are
optional peers; the watcher degrades to a no-op when the emitter is absent.
