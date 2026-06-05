---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
---

Add retention/prune controls and query EXPLAIN.

**Retention / prune.** A new `GET /api/retention` reports the configured retention
window (`entryCount`/`oldestCreatedAt` stay `null` — the storage SPI exposes no
cheap count/oldest, and Telescope never scans to derive them). `POST /api/retention/prune`
runs an on-demand prune behind the existing default-deny mutation gate
(`authorizeAction`); it 403s when mutations are disabled and 400s when no `prune`
window is configured. The Overview page gains a Retention card with a confirm-gated
"Prune now" button, shown only when `meta.pruneEnabled` (prune window AND mutations).

**Query EXPLAIN.** A new host hook
`explainQuery?: (sql, bindings) => Promise<unknown>` lets the host run an
engine `EXPLAIN` (it brings its own connection/dialect — e.g. MySQL
`EXPLAIN FORMAT=JSON`). `POST /api/queries/explain` loads the query entry and
returns `{ plan }`; a hook throw surfaces as a clean `{ message }`. The query
entry detail gains an "Explain" button (only when `meta.explainEnabled`) that
renders the plan JSON with loading/error states.

`TelescopeMeta` gains `pruneEnabled` and `explainEnabled`.
