---
'@dudousxd/nestjs-telescope': patch
---

Stop prune cycles from stacking on top of each other.

`TelescopePruner` drove its cycles from a fire-and-forget `setInterval` with no
in-flight guard, so a cycle that outran `prune.intervalMs` did not delay the next
tick — it ran alongside it. On a large store each tick added one more concurrent
`DELETE` over an overlapping row range, they blocked each other on row locks,
every one got slower, and the backlog never drained. Seen in production as 25
simultaneous prune deletes against one MySQL store, the oldest 63 minutes old.

A scheduled tick that lands while a cycle is in flight is now dropped (nothing is
lost: cutoffs are computed from `Date.now()` at the start of a cycle, so the next
one that runs simply deletes at a fresher cutoff), and it logs one warning per
overlap streak pointing at `prune.intervalMs` / `prune.after` / store indexing.
`pruneNow()` now joins the cycle already running instead of starting a competing
one, so repeated dashboard "Prune now" clicks cannot pile deletes onto a store
that is already struggling.

The guard is per-process. Replicas still prune independently against a shared
store, so bounding a fleet to one pruner at a time remains the host application's
job — a distributed lock, or configuring `prune` on only one role.
