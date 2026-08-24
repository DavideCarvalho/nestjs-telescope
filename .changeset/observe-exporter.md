---
'@dudousxd/nestjs-telescope-observe': minor
---

Add `@dudousxd/nestjs-telescope-observe`: a Telescope extension that forwards entries to NestJS Observe.

Telescope batches are reassembled into Observe's snapshot/span model — a request becomes a snapshot, the queries, cache operations, Redis commands and outbound HTTP calls it caused become child spans positioned by their offset into it, and queue and schedule runs become job snapshots. Section-level `include` flags, per-batch sampling that never drops a failure, and a host `filter` control what leaves the process; the transport gzips, retries what can succeed later, and trips a breaker on bad credentials.

Also fills the two sections Observe's dashboard leaves empty without them: a `runtime` snapshot (CPU, memory, GC by kind, event-loop lag and utilization) behind its Profiler, and `telescope.entries` / `telescope.duration_ms` custom metrics counted through the pre-sampling `observeRecord` hook, so they report what the process did rather than what survived sampling. Both were verified against the live collector, which answers 500 to a partial `runtime` — so an incomplete snapshot is withheld and retried rather than sent.
