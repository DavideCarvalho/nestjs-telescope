# @dudousxd/nestjs-telescope-observe — DEPRECATED

> **This package is deprecated and is no longer built or released.** The last published version
> is `0.1.0`. Do not add it to new projects; remove it from existing ones.

It forwarded Telescope entries to [NestJS Observe](https://observe.nestjs.com) by speaking
Observe's ingest wire directly. It is withdrawn for two reasons:

1. **License.** `@nestjs/observe` after 0.3.20 is under the
   [NestJS Observe Agent License](https://www.npmjs.com/package/@nestjs/observe?activeTab=code),
   which lets its telemetry go only to observe.nestjs.com and forbids using the software
   (source code included) to build a service that substitutes for, or receives telemetry like,
   theirs. This package's wire format was transcribed from the encoders in
   github.com/nestjs/observe, and it posts a second, non-Observe agent's telemetry to their
   collector. That is not something to keep shipping against a license that now governs the
   source it was read from.
2. **A private, unversioned wire.** Observe's ingest API is undocumented, absent from the npm
   tarball and carries no stability promise; a collector change can break it (a single unknown
   key fails the whole batch with a 400).

## What to use instead

- **To report into NestJS Observe:** use [`@nestjs/observe`](https://docs.nestjs.com) itself, the
  official agent, configured as its docs describe.
- **To keep Telescope's local console:** keep [`@dudousxd/nestjs-telescope`](../core) as it is,
  with your own storage. It does not need Observe.
- **To find one request in both tools:** give Telescope Observe's trace id with
  `ObserveTraceContextProvider` from
  [`@dudousxd/nestjs-telescope-official`](../official). It reads `TracerService.currentTraceId()`
  only — Telescope never receives Observe's spans or metrics, and nothing of Telescope's is sent
  to Observe.
