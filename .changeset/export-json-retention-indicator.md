---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
---

Surface JSON export and retention/sampling in the dashboard.

Core: `TelescopeMeta` (`GET /meta`) now reports the resolved `retention`
(`{ afterMs, keepLast }` from `prune`, or `null` when unbounded) and the
resolved per-type `sampling` rates, sourced from the resolved config.

UI: the entry-detail page gains a "Copy JSON" / "Download JSON" toolbar that
exports the full `EntryWithBatch` (`telescope-entry-<id>.json`); the trace page
gains a "Download JSON" button exporting all trace entries as a JSON array
(`telescope-trace-<traceId>.json`). The dashboard header shows a subtle
retention indicator (e.g. "retention: 5m", or "none" when unbounded) with a
sampling tooltip when any type is down-sampled below 1. New `toPrettyJson`,
`copyJson`, and `downloadJson` export utilities back the buttons; clipboard
absence degrades gracefully.
