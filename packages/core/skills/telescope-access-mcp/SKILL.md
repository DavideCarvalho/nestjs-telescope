---
name: telescope-access-mcp
description: >-
  Protecting nestjs-telescope's routes and the MCP server with the `authorize`
  option (TelescopeModule/TelescopeUiModule forRoot({ authorize }), otel
  forExporter(exporter, { authorize })): a function, an @Injectable()
  ConsoleAuthorizer class, a lazy import, { policy, ability } from
  @nestjs/authorization, or a gate name from @dudousxd/nestjs-authz; or
  routes:false plus your own subclasses with UseConsoleAuthorize. Without
  authorize the console is open outside production and answers 403 in
  production (one boot warning). Queue mutations need mutations:true. MCP is
  enabled with mcp:true and follows authorize, or its own mcpAuthorize
  (authorizeByToken for agents). Use for "lock down the dashboard", "console
  answers 403 in production", "retry/remove queue jobs are 403", "connect
  Claude Code / Cursor to Telescope", "protect /metrics".
license: MIT
metadata:
  type: core
  library: "@dudousxd/nestjs-telescope"
  library_version: "3.0.0"
  framework: nestjs
---

# Protecting the routes & MCP

Telescope has no login of its own: sign-in stays the app's. One option,
`authorize`, decides who may use the console. It runs after the app's
authentication (global guards and `decorators`), so `request.user` is set.

## Core patterns

### Pattern 1 — `authorize` on the modules

```ts
import { authorizeByToken } from '@dudousxd/nestjs-telescope';

const authorize = (ctx: ExecutionContext) =>
  ctx.switchToHttp().getRequest().user?.isAdmin === true;
// or: ConsoleAccess                                 (@Injectable() implements ConsoleAuthorizer)
// or: () => import('./console-access.js')           (lazy, default export)
// or: { policy: ConsolePolicy, ability: 'view' }    (@nestjs/authorization)
// or: 'console.telescope'                           (gate name, @dudousxd/nestjs-authz)
// or: authorizeByToken({ token: process.env.CONSOLE_TOKEN })

TelescopeModule.forRoot({ authorize });   // API, live stream, MCP
TelescopeUiModule.forRoot({ authorize }); // the page + assets
// forRootAsync: `authorize` may come from the factory
```

Results: `true`/`{ allowed: true }` allow; `false` → 403 `{ error: 'forbidden' }`
(the page gets an "Access denied" HTML page); `{ allowed: false, reason:
'unauthenticated' }` → 401; `{ redirectTo: '/login' }` → 302 for a page
navigation, 401 `{ error: 'unauthenticated', redirectTo }` for the API (the
dashboard follows it). A throw denies (403).

The page is a full-page navigation (cookies, no `Authorization` header), so its
check must read a cookie session. `decorators` (e.g.
`[UseGuards(AuthenticationGuard)]`) still apply and run before `authorize`.

### Pattern 2 — `routes: false` and your own controllers

```ts
import { UseConsoleAuthorize } from '@dudousxd/nestjs-telescope';

// ABOVE the auth guard: Nest applies class decorators bottom-up, so the auth
// guard runs first and sets request.user before `authorize` runs.
@Controller('ops/telescope/api')
@UseConsoleAuthorize()
@UseGuards(AuthGuard)
class ConsoleApi extends TelescopeController {}

@Module({
  imports: [
    TelescopeModule.forRoot({
      path: 'ops/telescope',
      routes: false,
      authorize: { policy: ConsolePolicy, ability: 'view' },
    }),
  ],
  controllers: [ConsoleApi],
})
export class OpsModule {}
```

`@UseConsoleAuthorize()` runs `TelescopeModule.forRoot({ authorize })`;
`@UseConsoleAuthorize({ authorize })` runs its own check. With `routes: false`
the module still logs the "no `authorize`" boot warning when it is omitted.
`StreamController`, `TelescopeMcpController`, `ClientErrorController` and
`TelescopeUiController` (from the UI package; it answers denied page
navigations with a page or a redirect) extend the same way. The base classes
carry no guard. Keep `path` set to the mount.

### Pattern 3 — queue mutations

```ts
TelescopeModule.forRoot({ authorize, mutations: true });
```

Retry/remove/promote/redrive/enqueue, prune, replay and profiling-arm answer
403 until `mutations: true`. For a rule on mutations stricter than on reads,
use Pattern 2 and override those methods with an extra `@Can(...)`
(re-declare the route decorators on the override).

### Pattern 4 — the MCP server

```ts
TelescopeModule.forRoot({
  mcp: true, // POST <path>/api/mcp
  authorize: { policy: ConsolePolicy, ability: 'view' },
  mcpAuthorize: authorizeByToken({ token: process.env.TELESCOPE_MCP_TOKEN }),
});
```

Without `mcp: true` the handler answers 404 (the route stays mounted, so the
access check answers 401/403 first). Agent clients send `Authorization: Bearer
<key>`, not the dashboard's cookie; `mcpAuthorize` REPLACES `authorize` on the
MCP route only. Then
`claude mcp add --transport http telescope <url>/api/mcp --header "Authorization: Bearer $TELESCOPE_MCP_TOKEN"`.

For a key per developer, use an `ApiKeyProvider` from `@nestjs/authentication`
in `mcpDecorators: [Authenticate({ providers: [TelescopeAgentKey] })]` (they
replace `decorators` on MCP) and keep `authorize` for the policy.

### Pattern 5 — `GET /metrics` (otel)

```ts
TelescopeOtelMetricsModule.forExporter(exporter, {
  authorize: authorizeByToken({ token: process.env.METRICS_TOKEN }),
});
```

Same contract and default as the console. Prometheus sends the token via
`authorization.credentials` in its scrape config.

## Common mistakes

### Mistake 1 — no `authorize` in production

```ts
// Wrong — boots, but every console request answers 403 in production, and the
// boot logs: "[@dudousxd/nestjs-telescope] console has no `authorize` configured…"
TelescopeModule.forRoot({ decorators: [UseGuards(AuthenticationGuard)] });

// Correct
TelescopeModule.forRoot({ decorators: [UseGuards(AuthenticationGuard)], authorize });
```

`decorators` alone do not count. The same rule applies to `TelescopeUiModule`
and `TelescopeOtelMetricsModule` (`/metrics`). Outside production the console
is open. Source: `packages/core/src/nest/console-authorize.guard.ts`.

### Mistake 2 — a token in the URL

`authorizeByToken` reads only the `Authorization: Bearer` header; `?token=` is
ignored. An empty token throws at config time.

### Mistake 3 — expecting the client-error beacon to be protected

`POST <path>/api/client-errors` is public by design (visitors' browsers report
to it), so it takes neither `decorators` nor `authorize`. It is off until
`clientErrors.enabled`, and keeps its byte cap and per-IP rate limit. To gate
it, use `routes: false` and extend `ClientErrorController`.

### Mistake 4 — expecting mutations to work once reads do

```ts
// Wrong — reads work, but retry/remove/promote still 403.
TelescopeModule.forRoot({ authorize });

// Correct
TelescopeModule.forRoot({ authorize, mutations: true });
```
