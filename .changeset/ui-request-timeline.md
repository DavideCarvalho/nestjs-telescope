---
'@dudousxd/nestjs-telescope-ui': minor
---

Show a request's batch as a compact timeline/waterfall in the entry detail. When
viewing a `request` entry that captured children (queries, cache, jobs, …), a new
`RequestTimeline` renders one row per batch entry ordered by `sequence`: a type
dot, a short label, a horizontal duration bar scaled to the slowest entry in the
batch, and the `durationMs`. Each row links to that child's detail. This makes
"where did the time go in this request" obvious without leaving for a trace
viewer. Null-duration children render with a minimal bar, and large batches cap
at 50 rows with a "+N more" note.
