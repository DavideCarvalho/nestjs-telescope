---
'@dudousxd/nestjs-telescope': minor
---

Add webhook alerting (v1).

A new `alerts` option evaluates rules on an unref'd interval and POSTs a JSON
payload to a `webhookUrl` when a rule fires (per-rule `cooldown` suppresses
re-notifies). Three rule kinds: `exception-rate` (`>= threshold` exceptions in a
`window`), `slow-request-rate` (`>= count` requests slower than `thresholdMs` in
a `window`), and `dropped-entries` (Recorder `droppedCount` grew by `>= threshold`
since the last evaluation — a delta). Exception/slow rules read a small,
content-omitted, scan-capped window via `collectEntriesInWindow`; dropped uses
the Recorder self-metrics delta.

The webhook POST is bounded by a 5s `AbortController` timeout; failures are
warn-logged once per rule kind and **never** throw into the host. A configured
`alerts` with an empty `webhookUrl` or empty `rules` (or an unparseable duration)
is a fail-closed boot error. `TelescopeMeta` gains `alerts: { enabled, ruleCount }`.
