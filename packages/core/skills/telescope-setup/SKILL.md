---
name: telescope-setup
description: >-
  Mount nestjs-telescope in a NestJS app with TelescopeModule.forRoot / forRootAsync.
  Covers the enabled flag, the default-deny production API gate and authorizer, the
  shared path option (must match TelescopeUiModule), prune retention, swapping the
  default in-memory SQLite StorageProvider, and the setGlobalPrefix /
  registerRequestMiddleware + telescopeRequestCapture caveat. Use for "set up
  Telescope", "dashboard returns 403/404 in production", "forRootAsync config".
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

@Module({
  imports: [
    TelescopeModule.forRoot({
      // dev: rich capture, open gate. prod: flip enabled + supply an authorizer.
      enabled: process.env.NODE_ENV !== 'production',
      authorizer: () => true, // gates the API; defaults to DENY in production
      prune: { after: '24h' },
    }),
    TelescopeUiModule.forRoot(),
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
`path` is a **static sibling** of `useFactory` — it is bound at module-build time
and is NOT read from the factory result.

```ts
import { ConfigModule, ConfigService } from '@nestjs/config';

TelescopeModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  path: 'observability', // static — NOT returned by the factory
  useFactory: (config: ConfigService) => ({
    enabled: config.get('TELESCOPE_ENABLED') === 'true',
    authorizer: () => true,
    prune: { after: '7d' },
  }),
});
```

Source: `packages/core/src/nest/telescope.module.ts` (`forRootAsync`).

### Pattern 2 — the production gate

In production the API gate is **default-deny**. To expose the dashboard in prod you
must BOTH set `enabled: true` AND supply an `authorizer` (or `dashboardAuth`). With
`enabled` false, capture stops; with no authorizer the API returns `403`.

```ts
TelescopeModule.forRoot({
  enabled: true,
  authorizer: (ctx) => isAdmin(ctx.request), // your own check on the platform request
});
```

The default authorizer allows when `NODE_ENV !== 'production'` and denies otherwise.
For a real login wall use the `telescope-access-mcp` skill (`dashboardAuth`).

Source: `packages/core/src/nest/telescope.options.ts` (`authorizer`),
`website/content/docs/getting-started.mdx` (production-gate callout).

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

### Mistake 1 — expecting the dashboard to work in production with defaults

```ts
// Wrong — in production this 403s: no authorizer, and capture is off.
TelescopeModule.forRoot({});
```

```ts
// Correct — open the gate explicitly in prod.
TelescopeModule.forRoot({
  enabled: process.env.NODE_ENV !== 'production' ? true : true,
  authorizer: (ctx) => isAdmin(ctx.request),
});
```

Mechanism: the API gate denies when `NODE_ENV === 'production'` until you supply an
`authorizer` (or `dashboardAuth`), and capture is gated by `enabled`.
Source: `packages/core/src/nest/telescope.options.ts`.

### Mistake 2 — passing `path` through the async factory

```ts
// Wrong — the route is bound at build time; this `path` is ignored.
TelescopeModule.forRootAsync({
  useFactory: () => ({ path: 'observability', enabled: true }),
});
```

```ts
// Correct — pass path as a static sibling of useFactory.
TelescopeModule.forRootAsync({
  path: 'observability',
  useFactory: () => ({ enabled: true, authorizer: () => true }),
});
```

Mechanism: the controller route is bound at module-build time, so the factory's
returned `path` cannot move it. Source: `packages/core/src/nest/telescope.module.ts`.

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
