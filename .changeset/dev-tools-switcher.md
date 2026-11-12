---
"@dudousxd/nestjs-telescope": minor
"@dudousxd/nestjs-telescope-ui": minor
---

Telescope's tools on the Aviary dev MCP endpoint, and the console switcher.

- `telescope_list_entries`, `telescope_get_entry`, `telescope_get_trace`, `telescope_get_waterfall`, `telescope_get_health` and (with AI diagnosis configured) `telescope_diagnose_exception` are served on the dev MCP endpoint of `@dudousxd/nestjs-agent-mcp-server`, gated by the console's `authorize`. On while the routes are mounted; `devTools: true` keeps them with `routes: false`, `devTools: false` turns them off. The standalone `<path>/api/mcp` endpoint is unchanged.
- `TelescopeMcpServer` (with a public `call(name, args)`) and `MCP_TOOLS` are exported.
- The sidebar brand becomes a menu of the other Aviary consoles the viewer may open, read from the new `GET <path>/api/consoles`.
- `anyAuthorize(...forms)`: allowed when any `authorize` form allows.
