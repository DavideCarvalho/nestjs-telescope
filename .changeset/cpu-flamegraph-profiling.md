---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
---

On-demand CPU flamegraph profiling. A new strictly-opt-in `profiling` option
(OFF by default) captures V8 CPU profiles around sampled or manually-triggered
requests via Node's `inspector`, aggregates them into a self/total frame tree,
and persists them as `cpu_profile` entries correlated to their request batch.
The dashboard gains a Profiles tab with a dependency-light flamegraph renderer,
a hot-functions table, and an "arm next N requests" trigger. New headless API
routes: `GET /profiles`, `GET /profiles/:id`, `GET /profiles/status`, and
`POST /profiles/arm` (gated by the default-deny mutation guard). When profiling
is disabled there is ZERO inspector usage and no request-path cost beyond a
single boolean check.
