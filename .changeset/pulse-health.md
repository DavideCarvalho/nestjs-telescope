---
'@dudousxd/nestjs-telescope': minor
---

Add a pulse health endpoint. `GET /telescope/api/pulse?window=1h` returns a
health snapshot aggregated from captured entries: per-type counts, slowest
entries (by duration), top exceptions (grouped by family), and per-batch N+1
query occurrences (`PulseService` + `summarizePulse`). The windowed-read loop is
extracted into a shared `collectEntriesInWindow` used by both pulse and queue
metrics.
