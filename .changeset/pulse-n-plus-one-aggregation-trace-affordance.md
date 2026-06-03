---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
---

Two pulse/dashboard UX improvements.

N+1 query hotspots are now aggregated by query family instead of listed per
request. `summarizePulse` returns `NPlusOneHotspot[]` — one row per family with
`perRequest` (worst single-request repetition), `requests` (how many requests
tripped the threshold), `total` (sum of repetitions), and `sampleBatchId` (the
worst batch). Identical queries that previously appeared as several identical
rows now collapse into a single hotspot, sorted by total repetitions. The Pulse
panel renders `×{perRequest} per request · {requests} requests · {total} total`
and links each hotspot to its query family (`#/entries/query?familyHash=…`).

The entries table now surfaces a subtle `trace:<id>` chip on any row that
belongs to a trace, linking straight to `#/traces/:traceId` so traces are
discoverable from the list without opening an entry's detail. Rows without a
trace show nothing extra.
