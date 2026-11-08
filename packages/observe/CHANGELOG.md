# @dudousxd/nestjs-telescope-observe

## 1.0.0

### Patch Changes

- [#178](https://github.com/DavideCarvalho/nestjs-telescope/pull/178) [`3222eae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/3222eae574429a9807784ba413e8f0e43c3d98d3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **Deprecated.** This package is no longer built or released (it is now `private` in the workspace); `0.1.0` is its last published version. It forwarded Telescope entries to NestJS Observe over Observe's private, undocumented and unversioned ingest wire, transcribed from the encoders in github.com/nestjs/observe, and `@nestjs/observe` after 0.3.20 is under the NestJS Observe Agent License, which only lets that telemetry go to observe.nestjs.com and forbids using the software (its source included) to build a service that receives such telemetry or substitutes for theirs. Use `@nestjs/observe` itself to report into NestJS Observe, keep Telescope for the local console, and use `ObserveTraceContextProvider` from `@dudousxd/nestjs-telescope-official` to give both the same trace id.

- Updated dependencies [[`3222eae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/3222eae574429a9807784ba413e8f0e43c3d98d3), [`3222eae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/3222eae574429a9807784ba413e8f0e43c3d98d3), [`3222eae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/3222eae574429a9807784ba413e8f0e43c3d98d3)]:
  - @dudousxd/nestjs-telescope@2.0.0

## 0.1.0

### Minor Changes

- [#90](https://github.com/DavideCarvalho/nestjs-telescope/pull/90) [`63d5650`](https://github.com/DavideCarvalho/nestjs-telescope/commit/63d5650da3333dac9f09ed8ac26ece4005e08471) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add `@dudousxd/nestjs-telescope-observe`: a Telescope extension that forwards entries to NestJS Observe.

  Telescope batches are reassembled into Observe's snapshot/span model — a request becomes a snapshot, the queries, cache operations, Redis commands and outbound HTTP calls it caused become child spans positioned by their offset into it, and queue and schedule runs become job snapshots. Section-level `include` flags, per-batch sampling that never drops a failure, and a host `filter` control what leaves the process; the transport gzips, retries what can succeed later, and trips a breaker on bad credentials.

  Also fills the two sections Observe's dashboard leaves empty without them: a `runtime` snapshot (CPU, memory, GC by kind, event-loop lag and utilization) behind its Profiler, and `telescope.entries` / `telescope.duration_ms` custom metrics counted through the pre-sampling `observeRecord` hook, so they report what the process did rather than what survived sampling. Both were verified against the live collector, which answers 500 to a partial `runtime` — so an incomplete snapshot is withheld and retried rather than sent.
