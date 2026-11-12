---
"@dudousxd/nestjs-telescope": minor
"@dudousxd/nestjs-telescope-ui": minor
---

Extension row actions and dev tools. `TelescopeExtension.actions()` declares write actions and a table column's `action` puts a button on matching rows (`showWhen`, input filled from the row). The dashboard asks for confirmation, then calls `POST <path>/api/ext/:ext/actions/:action` with `{ confirmed: true, input }`. Like every console mutation it needs `mutations: true`, passes the console's `authorize`, is refused from one organization's view, and writes an audit line with the caller through the `TelescopeAudit` logger. `TelescopeExtension.devTools()` adds tools next to telescope's own on the dev MCP endpoint, and `action` tools are audited the same way. `/api/meta` now lists `actions` and `mutations`. The controller also resolves `ModuleRef` explicitly, so `ctx.moduleRef` is set in extension providers whatever the build's decorator metadata.
