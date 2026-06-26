---
name: telescope-access-mcp
description: >-
  Dashboard access control and the MCP server in nestjs-telescope. Gate reads with
  authorizer(ctx) (default-deny in production) and queue mutations separately with
  authorizeAction(ctx, action) (default-deny ALWAYS). Add a cookie-session login
  wall with dashboardAuth.{secret,ttl,session,login} (two modes; missing secret or
  hook is a boot error). Expose a stateless MCP endpoint for coding agents with
  mcp:true (dev-only) or mcp:{ token } (Bearer-gated, required in production). Use
  for "lock down the dashboard", "login wall", "retry/remove queue jobs are 403",
  "connect Claude Code / Cursor to Telescope".
license: MIT
metadata:
  type: core
  library: "@dudousxd/nestjs-telescope"
  library_version: "1.12.0"
  framework: nestjs
---

# Dashboard access control & MCP

Telescope has two independent gates — one for reads (`authorizer`) and one for
mutations (`authorizeAction`) — plus an optional cookie-session login wall
(`dashboardAuth`) and a header-gated MCP endpoint for coding agents (`mcp`).

## Setup

The simplest production-safe gate authorizes reads off the platform request:

```ts
import { TelescopeModule } from '@dudousxd/nestjs-telescope';

TelescopeModule.forRoot({
  enabled: true,
  authorizer: (ctx) => isAdmin(ctx.request),            // gates GET /api/* (reads)
  authorizeAction: (ctx, action) => isAdmin(ctx.request), // gates queue mutations
});
```

Source: `packages/core/src/nest/telescope.options.ts`
(`authorizer`, `authorizeAction`, `AuthorizerContext`).

## Core patterns

### Pattern 1 — read gate vs action gate

`authorizer` defaults to "allow in dev, deny in prod"; `authorizeAction` defaults
to **deny always**. A throw in either is treated as a denial (fail closed).

```ts
TelescopeModule.forRoot({
  enabled: true,
  authorizer: (ctx) => Boolean((ctx.request as any).user),          // reads
  authorizeAction: (ctx, action) => (ctx.request as any).user?.role === 'admin', // retry/remove/promote/redrive
});
```

Source: `packages/core/src/nest/telescope.options.ts`.

### Pattern 2 — a login wall with `dashboardAuth`

When set, every guarded `/api/*` route requires a valid signed session cookie AND
the `authorizer` still runs (AND semantics). Provide a `secret` plus at least one
mode: `session` (bridge your host auth) or `login` (built-in username/password).

```ts
TelescopeModule.forRoot({
  enabled: true,
  dashboardAuth: {
    secret: process.env.TELESCOPE_SECRET!, // HMAC-SHA256 key, 32+ bytes; required
    ttl: '8h',
    login: (username, password) =>
      username === 'admin' && password === process.env.TELESCOPE_PASS
        ? { id: 'admin' }
        : null, // return null to reject
  },
});
```

Source: `packages/core/src/auth/dashboard-auth-config.ts` (`DashboardAuthOptions`,
`resolveDashboardAuth`), `website/content/docs/recipes/dashboard-auth.mdx`.

### Pattern 3 — the MCP server for coding agents

`mcp: true` exposes a stateless JSON-RPC endpoint at `<path>/api/mcp` (open only
when `NODE_ENV !== 'production'`). Pass `{ token }` to require a Bearer token —
the only way to expose it in production.

```ts
TelescopeModule.forRoot({
  mcp: { token: process.env.TELESCOPE_MCP_TOKEN }, // every request: Authorization: Bearer <token>
});
```

Register it with an agent:

```bash
claude mcp add --transport http telescope http://localhost:3000/telescope/api/mcp
```

Source: `packages/core/src/nest/telescope.options.ts` (`mcp`),
`packages/core/src/nest/telescope-mcp.controller.ts`,
`website/content/docs/concepts/mcp.mdx`.

## Common mistakes

### Mistake 1 — expecting `authorizer` to also gate mutations

```ts
// Wrong — reads work, but retry/remove/promote still 403: authorizeAction defaults to deny.
TelescopeModule.forRoot({ enabled: true, authorizer: () => true });
```

```ts
// Correct — supply authorizeAction to permit queue mutations.
TelescopeModule.forRoot({
  enabled: true,
  authorizer: () => true,
  authorizeAction: (ctx, action) => isAdmin(ctx.request),
});
```

Mechanism: mutations are a separate, default-deny gate so a read-open dashboard can
never retry/remove/redrive jobs without an explicit decision. Source:
`packages/core/src/nest/telescope.options.ts` (`authorizeAction`).

### Mistake 2 — `dashboardAuth` without a secret or any mode

```ts
// Wrong — both are fail-closed boot errors (empty secret; no session/login hook).
TelescopeModule.forRoot({ dashboardAuth: { secret: '' } });
TelescopeModule.forRoot({ dashboardAuth: { secret: 'k'.repeat(32) } });
```

```ts
// Correct — non-empty secret AND at least one of session/login.
TelescopeModule.forRoot({
  dashboardAuth: { secret: process.env.TELESCOPE_SECRET!, login: verifyCreds },
});
```

Mechanism: the cookie can never be minted without a signing secret and a mode, so
Telescope throws at boot rather than shipping an open or un-loginable dashboard.
Source: `packages/core/src/auth/dashboard-auth-config.ts` (`resolveDashboardAuth`).

### Mistake 3 — a tokenless MCP config in production

```ts
// Wrong — mcp: true is refused (403) in production; agents can't connect.
TelescopeModule.forRoot({ mcp: true });
```

```ts
// Correct — require a Bearer token to expose MCP in prod.
TelescopeModule.forRoot({ mcp: { token: process.env.TELESCOPE_MCP_TOKEN } });
```

Mechanism: without a token the MCP endpoint is allowed only when
`NODE_ENV !== 'production'` (mirroring the default-open-in-dev authorizer); a token
is the only production-safe exposure. Source:
`packages/core/src/nest/telescope.options.ts` (`mcp`).
