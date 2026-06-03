---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
---

Add slow-request hotspots to the pulse panel — like the N+1 hotspot, but for
endpoints: which routes are consistently slow, aggregated by route with `p99`,
`p50`, and request `count`.

Request entries now carry a readable, normalized **route family** as their
`familyHash` (e.g. `"GET /api/base/:id/mel"`), via a new pure
`normalizeRoute(method, url)` helper that strips the query string and replaces
id-like path segments (UUID / all-digits / long hex) with `:id`. The route
family doubles as the human label and indexes on the existing `family_hash`
column, so the new `slowRoutes` aggregation runs entirely over content-less
columns in the existing two-pass pulse scan — no `content` reads, no hydration.

The pulse panel renders a "Slow request hotspots" section; each row links
through to that route's request entries (`familyHash` filter).
