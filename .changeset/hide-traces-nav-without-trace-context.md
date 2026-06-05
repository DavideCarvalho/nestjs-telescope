---
"@dudousxd/nestjs-telescope": minor
"@dudousxd/nestjs-telescope-ui": minor
---

Hide the Traces page from the dashboard nav when the host has no `traceContext`.

Entries only get a `trace_id` when the host wires a `traceContext` provider, so an app without one had a permanently empty Traces page sitting as a dead nav item. The dashboard now hides that link — mirroring the watcher-driven nav, which already hides entry types whose watcher isn't registered.

- Core: `GET /api/meta` now returns `tracesEnabled: boolean` (whether a `traceContext` provider was configured).
- UI: the **Traces** nav item is hidden when `meta.tracesEnabled === false`. Undefined meta (loading, or an older server predating the field) still shows it — no flash-of-hidden-nav and backward-compatible. The `#/traces` route is untouched, so a direct visit still resolves.
