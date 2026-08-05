---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-bullmq': minor
'@dudousxd/nestjs-telescope-schedule': minor
'@dudousxd/nestjs-telescope-testing': minor
---

Let a throw outside the Nest pipeline become a real `exception` entry.

An `exception` entry had exactly one door: `TelescopeExceptionInterceptor`, a `NestInterceptor`. An
interceptor runs on the Nest execution pipeline and nowhere else, so a BullMQ job body, a `@Cron`
callback, a durable workflow step, an `@OnEvent` listener — every unit of work that a watcher already
gives a batch — could throw and produce no exception at all. The failure survived as a
`failureReason` string on that unit's own `job` entry: no family, so no `new-exception` alert, no AI
diagnosis, and nothing in the exceptions view. A nightly cron that had been throwing for a week was
visible only to whoever happened to open that one entry.

The fix is not "let each watcher build an exception entry too". Three things have to stay identical
across every door or the dashboard splits into parallel realities — the family hash, the 4xx
control-flow policy, and the entry shape — so the decision and the record were extracted into one
place that the interceptor, the service and every watcher call into.

- **`exception-capture.ts`** (new, exported) holds `isExpectedHttpControlFlow`,
  `toExceptionRecordInput` and `captureException`. The interceptor now delegates to it and keeps its
  behaviour byte-for-byte; an e2e over a real HTTP app pins the family hash, the 403 skip and the
  `captureHttp4xx` escape hatch so the extraction cannot drift.
- **`WatcherContext.recordException(error, details?)`** is the watcher-facing door, backed by the new
  `TelescopeService.recordException`. It records into whatever batch is active, so the exception
  correlates to the job or run it came from — one trace, not two. `details` carries the `context` and
  `tags` a watcher knows and a stack does not (which queue, which job id, which task), because off
  the request path there is no sibling `request` entry to read that from.
- **The 4xx skip now covers every door.** Hosts re-use `NotFoundException` in services that both a
  controller and a worker call; without this a retrying queue could open a new family, page on-call
  and burn a diagnosis through the back door the front door was hardened against after exactly that
  incident.
- **`TelescopeCrashCapture`** (the process-level `unhandledRejection`/`uncaughtException` hook) now
  builds its entry with the shared `toExceptionRecordInput` instead of its own copy, so a crash and a
  route throw of the same error stay one family by construction rather than by two functions agreeing.
  It deliberately does NOT go through the 4xx skip: a 4xx is expected control flow only while
  something is handling it, and a `NotFoundException` that reached `unhandledRejection` is a bug
  whatever its status says.
- **BullMQ and schedule watchers** hand their caught error over before re-throwing it. Recording can
  never change the host's control flow: the original error still propagates untouched, and a failure
  inside the capture path is swallowed and logged (the `safeRecord` precedent), guarded both by
  `captureException` and by the watchers' own try/catch.

Additive: `recordException` is declared optional on `WatcherContext` so hand-rolled contexts — the
fixtures every watcher package keeps in its specs — still type-check against the new core. Core
always supplies it. Out-of-repo watchers (`@dudousxd/nestjs-durable-telescope` and friends) opt in
with a single `ctx.recordException?.(error, { context })` in the catch block they already have.
