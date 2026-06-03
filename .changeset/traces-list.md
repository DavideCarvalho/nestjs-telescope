---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
---

Add a **Traces list** — browse recent distinct OTel traces instead of only
drilling in from a single entry. Core gains a pure `summarizeTraces` that groups
windowed entries by `traceId` (skipping null trace ids) into per-trace summaries
(`entryCount`, distinct sorted `types`, `firstAt`/`lastAt`, summed
`totalDurationMs`, optional `rootLabel`), a `TracesService` that scans the store
content-less over a window, and a `GET /telescope/api/traces?window=&limit=`
endpoint (read-guarded, mirrors `/timeseries`). The dashboard adds a **Traces**
nav item and a `#/traces` page listing recent traces — each row shows the root
label (or traceId), the type dots present, entry count, total duration, and
relative time, and links to the existing `#/traces/:traceId` grouping page.
