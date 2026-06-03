---
'@dudousxd/nestjs-telescope-ui': minor
---

Add a global live-tail pause/resume toggle to the dashboard. A `Live`/`Paused`
control in the header freezes all polling so you can inspect a moment in time.
`TelescopeProvider` now exposes a live-tail flag via `useLiveTail()`/`usePaused()`,
and every polling query hook (entries, meta, pulse, stats, queues, timeseries,
traces, live queues, queue jobs) sets `refetchInterval: false` while paused and
resumes at the normal interval when live. Default is live (unchanged behavior).
Manual navigation/clicks still fetch — only the interval is gated.
