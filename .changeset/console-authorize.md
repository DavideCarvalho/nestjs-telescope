---
"@dudousxd/nestjs-telescope": major
"@dudousxd/nestjs-telescope-ui": major
"@dudousxd/nestjs-telescope-otel": major
---

One `authorize` option decides who may use the console.

- `TelescopeModule.forRoot({ authorize })` covers the API, the live stream and the MCP endpoint; `mcpAuthorize` replaces it on MCP alone. `TelescopeUiModule.forRoot({ authorize })` covers the page and its assets, and `TelescopeOtelMetricsModule.forExporter(exporter, { authorize })` covers `GET /metrics`. With `forRootAsync`, `authorize` can come from the factory.
- `authorize` takes a function `(ctx) => result`, an `@Injectable()` class implementing `ConsoleAuthorizer`, a lazy `() => import(...)`, `{ policy, ability }` for `@nestjs/authorization` (now an optional peer), or a gate name resolved by `@dudousxd/nestjs-authz`.
- It returns `true`/`false`, `{ allowed }`, `{ allowed: false, reason: 'unauthenticated' }` or `{ redirectTo }`. Denials answer `403 { error: 'forbidden' }` or `401 { error: 'unauthenticated' }`; `redirectTo` gives a 302 for a page navigation and a 401 with `redirectTo` for an API call. A throw denies. A denied page navigation gets an "Access denied" page (403) or a "Sign in required" page (401).
- New `authorizeByToken({ token })` checks `Authorization: Bearer <token>` in constant time, for coding agents on MCP and Prometheus on `/metrics`. `@UseConsoleAuthorize()` protects controllers you mount yourself with `routes: false`: with no argument it runs `TelescopeModule`'s `authorize`; list it above your authentication guard so that guard runs first. `ConsoleAuthorizeGuard` (or `ConsoleAuthorizeGuard.for({ authorize })`) and `ConsoleAuthorizeFilter` are the guard and the denial filter on their own.
- The dashboard follows `redirectTo` from a 401 and shows an access-denied screen on a 403. `createTelescopeClient` takes an `onAccessDenied` callback.

**Breaking:**

- With no `authorize`, the console is open outside production and answers 403 to every request in production, with one warning at boot (also with `routes: false`). The production boot refusal ("refusing to mount undecorated routes with NODE_ENV=production") is removed, and `decorators` no longer count as protection on their own: keep authentication in `decorators` and move the authorization check to `authorize`.
- `assertConsoleProtected`, `CONSOLE_DECORATORS_EXAMPLE` and `ConsoleProtectionHint` are removed.
- otel: `requireProtectionInProduction` is removed. `/metrics` follows the console's rule, so it answers 403 in production until you set `authorize` (for example `authorizeByToken({ token: process.env.METRICS_TOKEN })`).
