---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
---

Client error ingestion — Telescope as the frontend error reporter.

A new **public** endpoint, `POST <telescope>/api/client-errors`, lets browsers report errors directly to Telescope instead of a hand-rolled reporter. Reports are recorded as `client_exception` entries through the normal pipeline, so they compose with everything: the `new-exception` alert, per-type prune/archive, and the dashboard.

- **Opt-in & ungated.** Configure via `clientErrors: { enabled, maxBodyBytes?, rateLimit?, authorize? }`. Disabled by default (a public surface is opt-in) — while off the endpoint returns 404. It carries no dashboard guard (ordinary users' browsers hit it).
- **Untrusted-body validation.** Dependency-free structural validation: `message` required, every other field optional with type checks + length caps (message ≤ 2 KB, stack/componentStack ≤ 16 KB, url/userAgent ≤ 2 KB). Invalid → 400 with no echo of the payload. Over the byte cap → 413.
- **Per-IP rate limit.** A bounded in-memory token bucket (default 60/min, ~10k IPs with oldest-IP eviction). Over the limit → 429. Per-pod best-effort (the effective limit is `perMinute × pods` in a multi-replica deployment).
- **`authorize` hook.** Runs first; `false` → 403 (a throw is a fail-closed denial). Lets hosts validate a session cookie/header.
- **Composes.** Records `type: client_exception` with a family hash from name + message + top stack frame (the server exception interceptor now uses the same scheme, so both sources group identically), the `failed` / `client` / `user:<id>` tags, and the captured client IP. The `new-exception` rule now fires for `client_exception` too, using the browser URL and user-agent in place of a server route.
- **Dashboard.** A new watcher-driven **Client errors** tab (shown only when `clientErrors` is enabled) with a detail view rendering message, stack, component stack, URL, and user-agent.

See the new recipe: *Reporting frontend errors*.
