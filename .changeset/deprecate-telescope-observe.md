---
"@dudousxd/nestjs-telescope-observe": patch
---

**Deprecated.** This package is no longer built or released (it is now `private` in the workspace); `0.1.0` is its last published version. It forwarded Telescope entries to NestJS Observe over Observe's private, undocumented and unversioned ingest wire, transcribed from the encoders in github.com/nestjs/observe, and `@nestjs/observe` after 0.3.20 is under the NestJS Observe Agent License, which only lets that telemetry go to observe.nestjs.com and forbids using the software (its source included) to build a service that receives such telemetry or substitutes for theirs. Use `@nestjs/observe` itself to report into NestJS Observe, keep Telescope for the local console, and use `ObserveTraceContextProvider` from `@dudousxd/nestjs-telescope-official` to give both the same trace id.
