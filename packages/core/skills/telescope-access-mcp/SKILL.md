---
name: telescope-access-mcp
description: >-
  Protecting nestjs-telescope's routes and the MCP server. Routes are protected
  only with @nestjs/authentication + @nestjs/authorization, one of two ways:
  decorators on the mounted controllers (TelescopeModule/TelescopeUiModule
  forRoot({ decorators })) or routes:false plus your own subclasses of the
  exported controllers. With NODE_ENV=production an undecorated mounted console
  fails the boot. Queue mutations need mutations:true. MCP is enabled with
  mcp:true and protected like any console route, or by its own mcpDecorators
  (an ApiKeyProvider Bearer key for agents). Use for "lock down the
  dashboard", "boot fails in production", "retry/remove queue jobs are 403",
  "connect Claude Code / Cursor to Telescope".
license: MIT
metadata:
  type: core
  library: "@dudousxd/nestjs-telescope"
  library_version: "1.12.0"
  framework: nestjs
---

# Protecting the routes & MCP

Telescope ships no access control of its own. Its routes are protected with
NestJS's first-party tools, `@nestjs/authentication` and `@nestjs/authorization`.

## Core patterns

### Pattern 1 — `decorators` on the mounted controllers

```ts
import { UseGuards } from '@nestjs/common';
import { AuthenticationGuard } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';

const protect = [UseGuards(AuthenticationGuard), Can(ConsolePolicy, 'view')];

TelescopeModule.forRoot({ decorators: protect });   // API, live stream, MCP
TelescopeUiModule.forRoot({ decorators: protect }); // the page + assets
// forRootAsync({ useFactory, decorators: protect }): a static top-level option
```

The page is a full-page navigation (cookies, no `Authorization` header), so the
authentication strategy in front of it must read a cookie session.

### Pattern 2 — `routes: false` and your own controllers

```ts
@Controller('ops/telescope/api')
@UseGuards(AuthenticationGuard)
@Can(ConsolePolicy, 'view')
class ConsoleApi extends TelescopeController {}

@Module({
  imports: [TelescopeModule.forRoot({ path: 'ops/telescope', routes: false })],
  controllers: [ConsoleApi],
})
export class OpsModule {}
```

`StreamController`, `TelescopeMcpController`, `ClientErrorController` and
`TelescopeUiController` (from the UI package) extend the same way. The base
classes carry no guard, so your decorators are the whole gate. Keep `path` set
to the mount.

### Pattern 3 — queue mutations

```ts
TelescopeModule.forRoot({ decorators: protect, mutations: true });
```

Retry/remove/promote/redrive/enqueue, prune, replay and profiling-arm answer
403 until `mutations: true`. For a rule on mutations stricter than on reads,
use Pattern 2 and override those methods with an extra `@Can(...)` (class and
method requirements both apply; re-declare the route decorators on the override).

### Pattern 4 — the MCP server

```ts
TelescopeModule.forRoot({ decorators: protect, mcp: true }); // POST <path>/api/mcp
```

Without `mcp: true` the handler answers 404 (the route stays mounted, so your decorators answer 401/403 first). Agent clients send
`Authorization: Bearer <key>`, not the dashboard's cookie. Give MCP its own
decorators with `mcpDecorators` (they REPLACE `decorators` on the MCP route
only) and an `ApiKeyProvider` from `@nestjs/authentication`:

```ts
import { ApiKeyProvider, Authenticate, AuthenticationRegistry, SessionCookieProvider } from '@nestjs/authentication';

@Injectable()
export class TelescopeAgentKey extends ApiKeyProvider<User> {
  constructor(private readonly agentKeys: AgentKeysRepository, registry: AuthenticationRegistry) {
    super({ prefix: 'tsc' });
    registry.registerProvider(this, { order: 2 });
  }
  findKey(id: string) {
    return this.agentKeys.findWithUser(id); // { hash, user, expiresAt } or null
  }
}

TelescopeModule.forRoot({
  mcp: true,
  decorators: [Authenticate({ providers: [SessionCookieProvider] }), Can(ConsolePolicy, 'view')],
  mcpDecorators: [Authenticate({ providers: [TelescopeAgentKey] }), Can(ConsolePolicy, 'view')],
});
```

Issue a key with `app.get(TelescopeAgentKey).generate()` (store `id` + `hash`,
show `key` once), then
`claude mcp add --transport http telescope <url>/api/mcp --header "Authorization: Bearer $KEY"`.
The key signs in its user, so `Can(...)` still applies (403 for a denied user).
`mcpDecorators: []` fails the production boot. With `forRootAsync`, pass
`mcpDecorators` statically, like `decorators` (`mcp: true` stays in the
factory); returned from the factory it has no effect and the boot warns.
If the app has a global filter turning 401 into a sign-in redirect, throw
your own `HttpException` (401) from the MCP guard so agents get a real 401.

## Common mistakes

### Mistake 1 — mounting the console in production with no decorators

```ts
// Wrong — with NODE_ENV=production this throws at module build:
// "TelescopeModule: refusing to mount undecorated routes with NODE_ENV=production…"
TelescopeModule.forRoot({});

// Correct — either way boots.
TelescopeModule.forRoot({ decorators: protect });
TelescopeModule.forRoot({ routes: false }); // + your own controllers
```

`decorators: []` counts as none. The same rule applies to `TelescopeUiModule`.
`TelescopeOtelMetricsModule` stays outside it by default: an undecorated
`GET /metrics` still boots with `NODE_ENV=production` (a Prometheus scrape
usually runs unauthenticated inside the cluster) unless
`requireProtectionInProduction: true` puts it under the same rule.
`routes: false` always boots. Outside production an undecorated console
mounts open. Source: `packages/core/src/nest/dynamic-controller.ts`
(`assertConsoleProtected`), `packages/otel/src/telescope-otel-metrics.module.ts`
(`requireProtectionInProduction`).

### Mistake 2 — expecting the client-error beacon to be protected

`POST <path>/api/client-errors` is public by design (visitors' browsers report
to it), so it does not receive `decorators`. It is off until
`clientErrors.enabled`, and keeps its byte cap and per-IP rate limit. To gate
it, use `routes: false` and extend `ClientErrorController`.

### Mistake 3 — expecting mutations to work once reads do

```ts
// Wrong — reads work, but retry/remove/promote still 403.
TelescopeModule.forRoot({ decorators: protect });

// Correct
TelescopeModule.forRoot({ decorators: protect, mutations: true });
```
