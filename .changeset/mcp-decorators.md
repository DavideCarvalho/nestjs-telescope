---
"@dudousxd/nestjs-telescope": minor
---

`mcpDecorators`: class decorators for the MCP route alone, in place of `decorators`. A coding agent sends `Authorization: Bearer <key>` while the dashboard sends a session cookie, so the MCP route can now take an `ApiKeyProvider` from `@nestjs/authentication` (`Authenticate({ providers: [TelescopeAgentKey] })`) while the API and live stream keep `decorators`. Leave it out and MCP takes `decorators` as before. `mcpDecorators: []` fails the boot with `NODE_ENV=production`, like an empty `decorators`. With `forRootAsync` it is a static top-level option. The MCP docs gain an end-to-end API-key recipe: the provider, issuing and revoking keys, and the Claude Code / `.mcp.json` setup.
