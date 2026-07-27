---
"@dudousxd/nestjs-telescope": minor
---

Add an optional `dashboardAuth.revalidate` hook so a renewed dashboard session re-checks the user.

The sliding renewal that keeps an active dashboard tab logged in (re-issuing the cookie once it's past 50% of its TTL) never consulted the host, so a deactivated or demoted operator kept dashboard access for as long as the tab stayed open.

- `dashboardAuth.revalidate?: (session: TelescopeSessionUser) => Promise<boolean> | boolean` — runs on the renewal path (at most once per `ttl/2` per session), receiving the already-minted session. Returning `false`, or throwing, clears the cookie and 401s in place — the same treatment as an absent cookie.
- Distinct from `session`/`login`: those hooks mint a session from a fresh request (which the dashboard's own XHRs don't carry host credentials for); `revalidate` only re-checks a session that already exists. It cannot mint one, so it does not count toward the "at least one of `session`/`login`" boot check and never appears in `modes`.
- Not immediate revocation: since it only runs on the renewal path, a demoted or deactivated operator can keep dashboard access for up to `ttl/2` after the change lands on the host side — 4 hours at the default 8h TTL.
- No `revalidate` configured: renewal behaves exactly as before.
