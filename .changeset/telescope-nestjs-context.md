---
"@dudousxd/nestjs-telescope": minor
---

Soft-detected `@dudousxd/nestjs-context` enrichment for recorded entries (additive, opt-in, no hard dependency).

When the app imports `@dudousxd/nestjs-context`, Telescope detects its accessor via the shared `CONTEXT_ACCESSOR` symbol (`@Optional() @Inject`) and enriches each recorded entry as a SECONDARY correlation source:

- **traceId** is taken from `accessor.traceId()` only as a FALLBACK when the OTel `traceContext` provider did not yield one — OTel always wins, so an existing OTel trace id is never clobbered. This lets entries correlate cross-lib (durable/notifications) with the shared context trace id when OTel is absent.
- **user/tenant tags** (`user:<Type>#<id>`, `tenant:<id>`) are appended so the dashboard can group/filter by the current user and tenant.

The accessor is read defensively once per entry and can never throw into `record()`. With no accessor bound, behavior is exactly as before.
