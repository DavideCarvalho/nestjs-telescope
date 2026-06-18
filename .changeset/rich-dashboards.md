---
'@dudousxd/nestjs-telescope': minor
---

Rich extension dashboards: the panel IR gains delta/sparkline/threshold on `stat`
and new `distribution`, `gauge`, and `breakdown` panel kinds, plus a `sections`
layout. Dashboards update in realtime over a new `@Sse` invalidation stream
(falling back to polling), with a LIVE indicator. Fully backward compatible —
existing extensions and flat `stat` panels render unchanged.
