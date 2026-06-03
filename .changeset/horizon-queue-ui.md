---
'@dudousxd/nestjs-telescope-ui': minor
---

Add the live queue management console. The Queues area now leads with a
master-detail manager (`#/queues`): a live queue list with per-state count
badges and paused indicators, state tabs, a dense job table with cursor-based
"Load more", and a slide-over job detail drawer (pretty-printed payload/opts,
timestamps, attempts, and stacktrace for failures). Retry / remove / promote
and "Retry all failed" actions render only when the driver advertises the
action and `mutationsEnabled` is true (server-side default-deny still enforced;
403s surface a friendly "Not authorized" hint). The Phase-3 throughput/runtime
metrics now live under a `Metrics` sub-tab (`#/queues/metrics`) so there is a
single, coherent "Queues" nav entry.
