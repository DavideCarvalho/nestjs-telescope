---
name: telescope-setup
description: >-
  Mount nestjs-telescope in a NestJS app with TelescopeModule.forRoot / forRootAsync.
  Covers the enabled flag, the production protection rule (decorators / routes:false), the
  shared path option (must match TelescopeUiModule), prune retention, swapping the
  default in-memory SQLite StorageProvider, and the setGlobalPrefix /
  registerRequestMiddleware + telescopeRequestCapture caveat. Use for "set up
  Telescope", "boot fails in production", "forRootAsync config".
license: MIT
metadata:
  type: core
  library: "@dudousxd/nestjs-telescope"
  library_version: "1.12.0"
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

const protect = [UseGuards(AuthenticationGuard), Can(ConsolePolicy, 'view')];

@Module({
  imports: [
    TelescopeModule.forRoot({
      prune: { after: '24h' },
      decorators: protect, // required in production (see Pattern 2)
    }),
    TelescopeUiModule.forRoot({ decorators: protect }),
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
  decorators: protect, // static too
  useFactory: (config: ConfigService) => ({
    enabled: config.get('TELESCOPE_ENABLED') === 'true',
    prune: { after: '7d' },
  }),
});
```

Source: `packages/core/src/nest/telescope.module.ts` (`forRootAsync`).

### Pattern 2 — protecting it (required in production)

Routes are protected only with `@nestjs/authentication` + `@nestjs/authorization`:
`decorators` on the mounted controllers, or `routes: false` plus your own
subclasses of the exported controllers. With `NODE_ENV === 'production'`, a
module that mounts its routes with no `decorators` (an empty array counts as
none) fails the boot with an error naming both ways. Outside production an
undecorated console mounts open.

```ts
const protect = [UseGuards(AuthenticationGuard), Can(ConsolePolicy, 'view')];
TelescopeModule.forRoot({ decorators: protect });
```

Details (self-mounting, MCP, mutations): the `telescope-access-mcp` skill.
Source: `packages/core/src/nest/dynamic-controller.ts` (`assertConsoleProtected`).

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
// Wrong — with NODE_ENV=production the boot fails: the console is undecorated.
TelescopeModule.forRoot({});
```

```ts
// Correct — protect it (or use routes: false and mount it yourself).
TelescopeModule.forRoot({ decorators: protect });
```

Mechanism: `assertConsoleProtected` throws at module build in production when
the module mounts its routes with no `decorators`. Capture is gated separately
by `enabled`. Source: `packages/core/src/nest/dynamic-controller.ts`.

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
