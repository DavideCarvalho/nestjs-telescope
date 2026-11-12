---
"@dudousxd/nestjs-telescope": minor
"@dudousxd/nestjs-telescope-ui": minor
---

Organizations as tenants (`@dudousxd/nestjs-context` tenancy). Off unless the context turns tenancy on; with it off, nothing changes.

- New `tenancy` option: `'inherit'` (default, follows `ContextModule`'s `tenancy.enabled`), `false`, or `{ enabled, kinds, nullRows, tag }`.
- With tenancy on, entries recorded for a tenant are tagged `tenant:<id>` from the context's tenant filter (honouring `kinds`), and `tenant:*` inside `Context.allTenants()`.
- `authorize` may return `{ allowed: true, tenants: '*' | string[] }`. With tenancy on, the console shows a viewer the organizations granted, or their own organization when `tenants` is absent (none: an empty console). Every API call takes `?tenant=<id>`, kept within that scope; a `tenant` outside it answers empty and is logged. The MCP endpoint and the dev tools follow the same rule. Clearing, pruning, live queues and schedules, extension data and the Prometheus scrape are only for viewers of every organization.
- AI diagnoses are cached and built per organization: a viewer of one organization only gets a diagnosis made from that organization's occurrences; a viewer of every organization reads the family's unscoped one. The SSE live feed only ticks for the viewer's organization. With tenancy off, both behave as before.
- New `GET <path>/api/tenancy` and an "Organization" control in the dashboard header: a chip for one organization, a searchable picker for several or all ("All organizations" first). The client sends the page's `?tenant=` on every call (`tenant` option, `client.tenancy()`).
- Exported: `ConsoleTenants`, `ConsoleTenantScope`, `resolveConsoleTenantScope`, `selectConsoleTenant` and `ConsoleTenancyInfo`, the console scope contract other Aviary consoles mirror.
