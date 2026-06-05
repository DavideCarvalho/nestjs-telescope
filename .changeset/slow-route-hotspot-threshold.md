---
"@dudousxd/nestjs-telescope": minor
"@dudousxd/nestjs-telescope-ui": minor
---

Pulse "Slow request hotspots" now require a real slowness threshold.

Previously the slow-route (and slow-outgoing-HTTP) hotspots were a pure top-N p99 ranking with no floor, so a quiet host surfaced fast routes like `/health` at 18ms as "hotspots" — a false alarm. A route now only counts as a hotspot when its **p99 ≥ `slowRouteMs`** (default `1000`ms, matching the `slow` request-tag threshold and the `HttpClientWatcher` `slowMs` default).

- Configure via `pulse.slowRouteMs` on `TelescopeModule.forRoot({ pulse: { slowRouteMs } })`.
- The Overview "Slow requests" stat is now labeled **Slow routes** and means "routes over the slow p99 threshold".
- The Pulse panel shows a friendly empty state ("No routes over the slow threshold") when nothing qualifies.
- The "Slowest" entries ranking and N+1 hotspots are unchanged — only slow-ROUTE hotspots gained the threshold.
