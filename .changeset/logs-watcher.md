---
'@dudousxd/nestjs-telescope-logs': minor
---

Add `@dudousxd/nestjs-telescope-logs` — `LogsWatcher` plus `TelescopeConsoleLogger`,
a drop-in `ConsoleLogger` that forwards Nest `Logger` output to a watcher-wired sink
and records each line as a `log` entry (`{ level, message, context }`), correlated to
the request/job that produced it. Telescope's own log contexts are skipped to avoid
feedback loops.
