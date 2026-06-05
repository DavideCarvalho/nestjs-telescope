---
'@dudousxd/nestjs-telescope': minor
---

Two Recorder robustness features: a bounded flush retry and tail-sampling.

- **Bounded flush retry.** A failed `storage.store(batch)` previously dropped the
  whole batch immediately. The Recorder now retries the batch **exactly once**
  after a bounded backoff (`recorder.retryDelayMs`, default `1000`ms); only a
  second failure drops it (the `storeFailedDropped` semantics are unchanged). The
  retry runs *inside* the single in-flight flush promise, so failed batches never
  pile up and the ring keeps absorbing/evicting meanwhile — memory stays bounded.
  The backoff timer is unref'd (never keeps the event loop alive), and a new
  `delay` seam keeps it deterministic in tests. A new `retriedFlushes`
  self-metric counts batches that needed the retry (surfaced via
  `getSelfMetrics()` / `GET /telescope/api/health`).

- **Tail-sampling.** `sampling` per-type values may now be a rule object —
  `{ rate, keepErrors?, keepSlowMs? }` — in addition to a bare keep-rate. The
  rule keeps `rate` of the noise but **always** retains errors (`keepErrors`: a
  `failed` tag, `content.failed === true`, or `content.statusCode >= 500`) and
  slow entries (`durationMs >= keepSlowMs`). Plain-number config keeps its exact
  prior behaviour. The decision uses only shallow fields already on the
  `RecordInput` (type, tags, durationMs, a couple of content property reads), so
  the hot path stays cheap. Resolution/normalization lives in `resolveConfig`.
