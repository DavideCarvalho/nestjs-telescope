---
"@dudousxd/nestjs-telescope-logs": minor
"@dudousxd/nestjs-telescope": minor
---

LogsWatcher now auto-patches the `@nestjs/common` `Logger` facade by default, so logs are captured with zero host changes — every `new Logger(Ctx)` instance log and `Logger.log(...)` static is recorded, the original is still invoked, and the patch is idempotent process-wide. Instance and static calls are independent paths in Nest 11 (an instance log delegates to a per-logger `ConsoleLogger`, a static log to `Logger.staticInstanceRef`), so both the `Logger.prototype` methods and the static `Logger.*` methods are teed under sibling `Symbol.for` markers; each logical call records exactly once. The explicit `TelescopeConsoleLogger` path remains for hosts that bypass the facade; both coexist without double-recording thanks to a shared re-entrancy guard (opt out with `new LogsWatcher({ autoPatch: false })`). Core's tail-sampling `keepErrors` is now level-aware: `warn` / `error` / `fatal` log entries count as errors, so `sampling: { log: { rate: 0.1, keepErrors: true } }` samples logs hard while never dropping warnings or errors.
