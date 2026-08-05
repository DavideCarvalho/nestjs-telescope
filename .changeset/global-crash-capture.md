---
'@dudousxd/nestjs-telescope': minor
---

feat(core): opt-in capture of process-level crashes as `exception` entries

Exception capture rode the Nest pipeline, so it only ever saw errors thrown out
of a route handler. A promise rejected with nobody awaiting it, or a throw that
escaped to the event loop from a timer or a stream callback, produced nothing at
all: no entry, no exception family, no `new-exception` alert. The failures with
the least observability were the ones that ended the process.

`exceptions.processCrashes.enabled` (default `false`) records
`process.on('unhandledRejection')` and `process.on('uncaughtException')` as
ordinary `exception` entries, with the same family hash the interceptor uses, so
a crash and a route-handler throw of the same error group together.

It is opt-in because attaching an `uncaughtException` listener *suppresses*
Node's default fatal exit, and a library must not change a host's crash
semantics behind its back. `onCrash` states the contract: `'exit'` reproduces
Node's default (stack to stderr, `process.exit(exitCode)`), `'passthrough'`
records only and leaves the exit to whoever already owns it, and the default
`'auto'` picks between them at bootstrap by counting pre-existing listeners —
zero means nothing else was deciding and Node would have crashed, so Telescope
crashes.

The flush is raced against `flushTimeoutMs` (default 2s) on an unref'd timer
rather than awaited, so a wedged storage provider delays a dying process by a
bounded amount instead of hanging it, and a failure inside the recording path
can never mask the original error. The active batch survives into the handler
via `AsyncLocalStorage`, so a crash inside a request/job/cron tick inherits its
`batchId`, `origin` and `traceId`; with no active batch it is recorded as
explicitly `orphaned` rather than dropped. Registration is idempotent per
process and `onModuleDestroy` removes the listeners.
