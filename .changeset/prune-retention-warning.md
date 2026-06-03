---
'@dudousxd/nestjs-telescope': minor
---

Warn at boot when no `prune` is configured. Without a retention window the entry
table grows unbounded and the windowed analytics scans (pulse/timeseries/stats)
slow down over time; the warning points hosts at `prune` (and `sampling` for
noisy request volume) before they hit it in production.
