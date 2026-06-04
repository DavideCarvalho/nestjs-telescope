---
'@dudousxd/nestjs-telescope': minor
---

Add the `event` and `log` entry types (`EntryType.Event` / `EntryType.Log`) and
their content shapes `EventContent { name, payload, listenerCount }` and
`LogContent { level, message, context }`, consumed by the new
`@dudousxd/nestjs-telescope-events` and `@dudousxd/nestjs-telescope-logs` watchers.
