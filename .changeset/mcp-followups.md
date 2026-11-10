---
"@dudousxd/nestjs-telescope": patch
---

`forRootAsync` follow-ups found testing `mcpDecorators` in real apps:

- The static `path` now reaches the providers. Before, `forRootAsync({ path: 'ops/telescope', useFactory })` mounted the routes at `ops/telescope` while request capture and the UI kept the factory's `path` (or the default `telescope`), so the console's own calls were captured and assets resolved against the wrong base. A different `path` from the factory is logged and overridden.
- `decorators`, `mcpDecorators`, `routes` and `imports` returned by the factory had no effect, silently (a returned `mcpDecorators` left MCP on `decorators`). The boot now logs a warning naming them.
- MCP `initialize` reports the package's real version in `serverInfo` instead of `0.0.0`.
- Docs: with `mcp` off the handler answers 404 only after your decorators (a refused caller gets their 401/403); how a global 401→redirect filter and a missing `WWW-Authenticate` header affect agent clients.
