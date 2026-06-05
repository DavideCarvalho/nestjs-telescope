---
"@dudousxd/nestjs-telescope-ui": minor
---

Three dashboard improvements:

- **Criticality-first Overview.** The Overview is reorganized so operational triage sits above the fold: a focused stat row (Requests, **Error rate** = exceptions ÷ requests over the window — red above 5%, Failed jobs, and **Slow requests** = routes over their p99 budget), then Recent failures, a newly-mounted **N+1 query hotspots** card, Slowest, and a **Queues needing attention** card that lists only queues with failed jobs or a large pending backlog (and says "All queues healthy" when clean). Trends and Telescope self-health (throughput, by-type, server, health, retention) move below. All figures derive from data already served by `/pulse` and `/queues` — no new endpoints.
- **Watcher-driven navigation.** The sidebar Watchers list and the type-tabs strip render only types whose watcher is registered (from `meta.watchers`); `request` and `exception` always show, direct URLs to hidden types still work, and everything shows while `meta` is loading (no flash of hidden nav).
- **Dedicated User filter.** The entries filter bar gains a User combobox over the `user:` tag namespace (bare ids + counts); selecting one applies the `tag=user:<id>` filter but renders as a `User: <id>` chip, and a `user:` tag arriving via `?tag=` (the entries-table pivot links) is recognized and shown in the User control instead of the generic tag chip.
