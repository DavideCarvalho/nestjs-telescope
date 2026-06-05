---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': patch
---

Bound memory by design at capture time, fixing a production OOM incident.

A host hit a GC death spiral at its container limit. There was no unbounded leak:
the heap was a retained *working set* — `prune.after × ingest rate × bytes per
entry` — amplified by `redact()` deep-cloning fat enumerable object graphs (a
host's `req.user` ORM entity → tens-of-KB..MB clones per entry), high-cardinality
cache capture volume, and the Recorder ring never nulling drained slots (stale fat
entries lingered up to capacity). The synchronous `redact()` detach is
load-bearing and must stay synchronous, so the fix bounds the clone instead of
deferring it.

- **Bounded redaction (on by default).** `redact()` now applies hard, overridable
  bounds: `maxDepth` (8), `maxStringLength` (8_192), `maxArrayLength` (200), and a
  per-call `maxNodes, maxContentBytes (16KB serialized-byte budget — the deterministic bytes-per-entry cap)` (5_000) node budget that caps a mega-graph regardless of its
  shape. Defaults are generous — a normal request / query / cache entry is cloned
  byte-identically; bounds only bite on pathological content. Key/path masking,
  cycle-safety, sync-and-never-throwing behavior, and the public `redact()`
  signature are unchanged. A new sibling `redactBounded()` also returns whether
  truncation happened.
- **Recorder hardening.** `drain()` nulls drained ring slots so flushed fat
  entries aren't retained afterward. A new `truncatedCount` self-metric counts
  entries whose content hit a bound; it surfaces automatically in
  `GET /telescope/api/health`, and the dashboard Overview adds a *Truncated* stat
  card (ui patch).
- **High-volume guidance.** When `prune` is set but `sampling` is empty, boot logs
  a one-line INFO pointing at per-type sampling (e.g. `sampling: { cache: 0.1 }`)
  to bound store volume on high-cardinality streams.
