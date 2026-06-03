---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
---

Make the telescope mount path configurable. `TelescopeModule.forRoot({ path:
'observability' })` and `TelescopeUiModule.forRoot({ path: 'observability' })`
now serve the dashboard at `/observability` and the API at `/observability/api`.
The `path` option (normalized — leading/trailing slashes stripped) defaults to
`'telescope'`, so behavior is byte-identical when unset.

Core binds the API controller route at module-build time via a per-`forRoot`
subclass of `TelescopeController` (`dynamicController(...)`), preserving all
route/DI metadata. `forRootAsync` accepts a static `path` field (the route must
be known synchronously). The request-capture middleware now skips the configured
path instead of a hardcoded `/telescope`, and the resolved core config exposes
`path`.

The UI is **not** rebuilt per-path: the SPA keeps the `/telescope/` Vite base
placeholder and the UI controller rewrites the asset base to `/<path>/` at serve
time, injecting `window.__TELESCOPE_BASE__` so the client derives its API base
(`createTelescopeClient` falls back to `/telescope/api` when the global is
absent; an explicit `baseUrl` still wins). Asset traversal safety is unchanged.
