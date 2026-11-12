# @dudousxd/nestjs-telescope-official

## 0.1.1

### Patch Changes

- [#183](https://github.com/DavideCarvalho/nestjs-telescope/pull/183) [`1a1d056`](https://github.com/DavideCarvalho/nestjs-telescope/commit/1a1d0560b680349d4e1ce142a61910ddebcb9ae2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Works with `@dudousxd/nestjs-telescope` 3: the peer range is now `^2.0.1 || ^3.0.0`. Nothing else changes.

## 0.1.0

### Minor Changes

- [#178](https://github.com/DavideCarvalho/nestjs-telescope/pull/178) [`3222eae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/3222eae574429a9807784ba413e8f0e43c3d98d3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add `@dudousxd/nestjs-telescope-official`: Telescope for NestJS's first-party packages, with no runtime dependency on any of them (every payload is read structurally, so their 0.x churn degrades to fewer fields, never a crash).

  - **Official channels watchers** (`officialWatchers()`, or one by one): `NestResilienceWatcher` records `@nestjs/resilience`'s 9 `nestjs:resilience:*` channels (retries, timeouts, breaker transitions and refusals, bulkhead and rate-limit refusals, fallbacks) as `resilience` entries; `NestWorkflowsWatcher` records `@nestjs/workflows`' 19 `nestjs:workflows:*` lifecycle events as `workflow` entries; `NestAuthWatcher` records `@nestjs/authentication`'s 13 audit events and `@nestjs/authorization`'s `nestjs:authorization:denied` as `auth` entries; `NestMailWatcher` records `nestjs:mail:sent` / `nestjs:mail:failed` as Telescope's built-in `mail` entries. The payloads carry no trace id: the subscriber runs in the publisher's async context, so each entry joins the request/job batch and the current trace. Auth entries are redacted: only known fields are copied, session and refresh-token-family ids become a SHA-256 fingerprint (`sessionRef`, `tokenFamilyRef`), emails are masked, session `metadata` keeps its key names only, and a denial keeps the user's id and the argument count, never the user object or the records. Refusals and security signals are tagged `failed`.
  - **`telescopeAiUsage()`**: an `onUsage` listener for `@nestjs/ai` (`AiModule.forRoot({ onUsage: telescopeAiUsage() })` or a call's `onUsage`). Each model call becomes a `usage.recorded` `agent` entry in the shape the AI screen already reads (feature = the call's `label`, cached input as `cacheReadTokens`, cost as `costSource: 'estimate'`), and is counted by the AI metrics (`aiMetrics.prometheus`, the otel AI exporter). Options: `feature`, `actor`, `toUsd`, `record`, `metrics`.
  - **`ObserveTraceContextProvider`**: Telescope's `traceContext` from `@nestjs/observe`'s `TracerService.currentTraceId()` (the UUID as 32 hex digits, a non-hex `x-request-id` hashed, a synthetic span id), so one request carries the same id in Telescope and in NestJS Observe. It reads the trace id only: Telescope never ingests Observe's spans, metrics or any other telemetry.

  The channel lists are kept in this package for now; they can come from `@dudousxd/nestjs-diagnostics` once its official-channel constants are published.
