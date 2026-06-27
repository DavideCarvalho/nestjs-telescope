---
"@dudousxd/nestjs-telescope": patch
---

Fix extension dashboards that use the sectioned layout rendering blank. The
`GET /telescope/api/meta` serializer dropped the `sections` field, so a dashboard
that declares its panels under `sections` (with a flat `panels: []`) — e.g. the
durable Workflows dashboard — arrived with no panels and the UI fell back to the
empty `panels` array. `sections` is now forwarded in meta.
