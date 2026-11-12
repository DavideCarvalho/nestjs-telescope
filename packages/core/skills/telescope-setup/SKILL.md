---
name: telescope-setup
description: >-
  Mount nestjs-telescope in a NestJS app with TelescopeModule.forRoot / forRootAsync.
  Covers the enabled flag, access with `authorize` (403 in production when omitted), the
  shared path option (must match TelescopeUiModule), prune retention, swapping the
  default in-memory SQLite StorageProvider, and the setGlobalPrefix /
  registerRequestMiddleware + telescopeRequestCapture caveat. Use for "set up
  Telescope", "console answers 403 in production", "forRootAsync config".
license: MIT
metadata:
  type: core
  library: "@dudousxd/nestjs-telescope"
  library_version: "3.0.0"
  framework: nestjs
---

# Setting up nestjs-telescope

`@dudousxd/nestjs-telescope` is an observability console for NestJS. Importing the
module wires **request and exception capture automatically** and turns on a
zero-config in-memory SQLite store. Everything else (other watchers, storage,
auth, alerts) is layered on through `forRoot` options.

## Setup

Install core plus the dashboard:

```bash
pnpm add @dudousxd/nestjs-telescope @dudousxd/nestjs-telescope-ui
```

Import both modules in your root module:

```ts
import { Module } from '@nestjs/common';
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { TelescopeUiModule } from '@dudousxd/nestjs-telescope-ui';

const authorize = (ctx: ExecutionContext) =>
  ctx.switchToHttp().getRequest().user?.isAdmin === true;

@Module({
  imports: [
    TelescopeModule.forRoot({
      prune: { after: '24h' },
      authorize, // without it, production answers 403 (see Pattern 2)
    }),
    TelescopeUiModule.forRoot({ authorize }),
  ],
})
export class AppModule {}
```

Boot and open `/telescope` for the dashboard, or `GET /telescope/api/entries` for
the headless JSON API. The two modules MUST agree on `path` (default `telescope`).

Source: `packages/core/src/nest/telescope.module.ts`,
`website/content/docs/getting-started.mdx`.

## Core patterns

### Pattern 1 — async config with `forRootAsync`

Use a factory when options depend on `ConfigService` or other providers. The
`path` is a **static sibling** of `useFactory` — it mounts the routes at
module-build time AND is copied into the resolved options so request capture
and the UI agree with the mount. A different `path` returned by the factory is
logged and overridden; a factory-only `path` (no static one) is kept for the
providers but does not move the routes, and the boot warns unless
`routes: false`.

```ts
import { ConfigModule, ConfigService } from '@nestjs/config';

TelescopeModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  path: 'observability', // static — NOT returned by the factory
  useFactory: (config: ConfigService) => ({
    enabled: config.get('TELESCOPE_ENABLED') === 'true',
    prune: { after: '7d' },
    authorize: authorizeByToken({ token: config.get('TELESCOPE_TOKEN') }), // may come from the factory
  }),
});
```

Source: `packages/core/src/nest/telescope.module.ts` (`forRootAsync`).

### Pattern 2 — protecting it (`authorize`)

`authorize` decides who may use the console: a function, an `@Injectable()`
`ConsoleAuthorizer` class, a lazy import, `{ policy, ability }`
(`@nestjs/authorization`) or a gate name (`@dudousxd/nestjs-authz`). Without
it the console is open outside production; with `NODE_ENV === 'production'`
every request answers 403 and one warning is logged at boot. `decorators`
(authentication etc.) run first but don't count on their own.

```ts
TelescopeModule.forRoot({ authorize: { policy: ConsolePolicy, ability: 'view' } });
```

Details (self-mounting, MCP, mutations): the `telescope-access-mcp` skill.
Source: `packages/core/src/nest/console-authorize.guard.ts`.

### Pattern 3 — retention with `prune`

`prune.after` is a duration string or number of ms. Add `intervalMs` to tune the
sweep cadence and `keepLast` to always retain the newest N regardless of age.

```ts
TelescopeModule.forRoot({
  prune: { after: '24h', intervalMs: 60_000, keepLast: 1000 },
});
```

Per-type retention and archive-before-prune live in the
`telescope-storage-retention` skill.

Source: `packages/core/src/config/options.ts` (`PruneOptions`).

## Common mistakes

### Mistake 1 — deploying to production with the defaults

```ts
// Wrong — with NODE_ENV=production every console request answers 403.
TelescopeModule.forRoot({});
```

```ts
// Correct — say who may use it (or use routes: false and mount it yourself).
TelescopeModule.forRoot({ authorize });
```

Mechanism: the console's guard answers 403 in production when `authorize` is
omitted, and the boot logs a warning. Capture is gated separately by `enabled`.
Source: `packages/core/src/nest/console-authorize.guard.ts`.

### Mistake 2 — passing `path` through the async factory

```ts
// Wrong — the route is bound at build time; this `path` does not move it.
// With no static `path` it is kept for the providers but the routes stay at
// the default, and the boot warns.
TelescopeModule.forRootAsync({
  useFactory: () => ({ path: 'observability', enabled: true }),
});
```

```ts
// Correct — pass path as a static sibling of useFactory.
TelescopeModule.forRootAsync({
  path: 'observability',
  useFactory: () => ({ enabled: true }),
});
```

Mechanism: the controller route is bound at module-build time, so the factory's
returned `path` cannot move it. The static `path` is copied into the resolved
options so capture and the UI agree with the mount; a different factory `path`
is logged and overridden. Source: `packages/core/src/nest/telescope.module.ts`,
`packages/core/src/nest/async-static-options.ts` (`withStaticOptions`).

### Mistake 3 — using `setGlobalPrefix` and capturing only `/`

```ts
// Wrong — under app.setGlobalPrefix('api') the module middleware only sees '/'.
TelescopeModule.forRoot({ enabled: true });
```

```ts
// Correct — opt out of the module middleware and register capture globally.
import { TelescopeService, telescopeRequestCapture } from '@dudousxd/nestjs-telescope';

TelescopeModule.forRoot({ enabled: true, registerRequestMiddleware: false });
// in bootstrap, after creating the app:
app.use(telescopeRequestCapture(app.get(TelescopeService)));
```

Mechanism: NestJS scopes module middleware (even a catch-all) to the prefixed route
table, so only `/` is captured; a raw `app.use` runs before all handlers regardless
of prefix. Source: `packages/core/src/nest/telescope.options.ts`
(`registerRequestMiddleware`), `packages/core/src/nest/telescope.module.ts`.
