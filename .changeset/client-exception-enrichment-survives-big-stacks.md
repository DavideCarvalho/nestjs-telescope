---
"@dudousxd/nestjs-telescope": minor
---

Stop big component stacks from silently evicting client-exception enrichment (IP/geo/URL/user-agent), and add per-entry-type redaction budgets.

Two related changes to how `client_exception` content survives the Recorder's content-byte budget (`redact.maxContentBytes`):

- **Reorder client-error content so enrichment leads.** The budget walks content keys in insertion order and drops every key once the budget is exhausted. A deep React error boundary produces a `componentStack` of many KB, which — placed before `url`/`userAgent`/`clientIp` — starved those short fields out of the entry. The server-derived `clientIp` was last, so it was the first casualty: no IP meant no `geoLookup`, so the Slack alert lost its Client IP **and** Location (plus URL and User agent) on exactly the errors with the largest stacks. Client-error content now orders `clientIp`, then the short enrichment fields, with `stack`/`componentStack` **last** — so the budget only ever truncates the stacks it's meant to.
- **New `redact.perType` option.** Numeric bounds (`maxContentBytes`, `maxDepth`, `maxStringLength`, `maxArrayLength`, `maxNodes`) can now be overridden per entry `type`, e.g. `redact: { maxContentBytes: 4096, perType: { exception: { maxContentBytes: 16384 }, client_exception: { maxContentBytes: 16384 } } }`. This lets rare, high-value exception entries keep their full stacks without loosening the OOM guard on high-volume request/query/cache entries. Masking (`keys`/`paths`) stays global. Exported type: `RedactBounds`.
