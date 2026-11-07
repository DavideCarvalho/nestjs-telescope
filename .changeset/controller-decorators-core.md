---
"@dudousxd/nestjs-telescope": minor
---

**Breaking:** Telescope's routes are now protected only with NestJS's first-party tools, `@nestjs/authentication` and `@nestjs/authorization`, either with `decorators` on the mounted controllers or by mounting the routes yourself (`routes: false`). Every built-in access control is removed: `authorizer`, `guards`, `dashboardAuth` (the session cookie, the `/api/auth/*` controller `TelescopeAuthController`, the login / session modes, `revalidate`, `unauthenticatedPage`, and the exported cookie/session helpers), `TelescopeGuard` and its "open outside production, closed in production" default, `TelescopeActionGuard`, `authorizeAction`, `clientErrors.authorize`, the MCP Bearer token (`mcp: { token }`) and its dev-only check, and `meta.auth`.

`decorators` puts class decorators on the console controllers the module mounts (API, SSE stream, MCP), e.g. `[UseGuards(AuthenticationGuard), Can(ConsolePolicy, 'view')]`; on `forRootAsync` it is a static top-level option. Every mounted controller is also marked open to `@nestjs/authorization`'s deny-by-default global `AuthorizationGuard` (the `Can.Anyone()` mark), and a `Can()` passed in `decorators` is still enforced. Each registration gets fresh controller subclasses, so decorators don't leak between registrations. `dynamicController` takes an optional `decorators` argument; `applyControllerDecorators` and `assertConsoleProtected` are exported.

**Production rule:** with `NODE_ENV=production`, mounting the console with no `decorators` (an empty array counts as none) fails the boot with an error naming both ways to protect it. `routes: false` always boots; outside production an undecorated console mounts open. The client-error beacon (`POST <path>/api/client-errors`) is public by design: it takes no `decorators` and is outside the rule.

Features that used to ride on access control stay: `mutations: true` turns on queue actions, prune, replay and profiling-arm (off: 403, `meta.mutationsEnabled`), and `mcp: true` still enables the MCP endpoint (now 404 while off).

Migration:
- `authorizer` / `guards: [G]` → `decorators: [UseGuards(G), Can(Policy, 'view')]`, or `routes: false` + your own subclasses of `TelescopeController` / `StreamController`.
- `dashboardAuth` → your app's own sign-in through `@nestjs/authentication`.
- `authorizeAction` → `mutations: true`; for a stricter rule, override the mutation methods in your subclass with an extra `@Can(...)`.
- `clientErrors.authorize` → `routes: false` + your own `ClientErrorController` subclass.
- `mcp: { token }` → `mcp: true` + a Bearer strategy in `decorators`.
- Production deployments must now pass `decorators` (or use `routes: false`), or the boot fails.
