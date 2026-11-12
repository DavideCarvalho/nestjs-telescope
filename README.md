<p align="center">
  <a href="https://davidecarvalho.github.io/aviary/docs/telescope">
    <img src="./.github/banner.svg" alt="nestjs-telescope — an Aviary library. Call sign: Owl.">
  </a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@dudousxd/nestjs-telescope"><img src="https://img.shields.io/npm/v/@dudousxd/nestjs-telescope?color=E0234E&label=npm&logo=npm&logoColor=white" alt="npm"></a>
  <a href="https://github.com/DavideCarvalho/nestjs-telescope/actions/workflows/ci.yml"><img src="https://github.com/DavideCarvalho/nestjs-telescope/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-3b82f6.svg" alt="License: MIT"></a>
  <a href="https://davidecarvalho.github.io/aviary/docs/telescope"><img src="https://img.shields.io/badge/docs-Aviary-E0234E?logo=readthedocs&logoColor=white" alt="Documentation"></a>
</p>

<p align="center">
  <b><a href="https://davidecarvalho.github.io/aviary/docs/telescope">📖 Documentation</a></b>
  &nbsp;·&nbsp; part of the <a href="https://davidecarvalho.github.io/aviary/"><b>Aviary</b></a> ecosystem for NestJS 🦉
</p>

> Laravel Telescope, redesigned for NestJS. Watch every request, query, job,
> email, cache hit, and exception — correlated under one batch, off the response
> path, pluggable, and safe in production. Alert new errors to Slack, diagnose
> them with AI, capture frontend errors, and archive before you prune. Express
> **and** Fastify.

`@dudousxd/nestjs-telescope` is an application observability console for NestJS.
A set of watchers capture what happens *inside* a request — every query, queued
job, sent email, cache hit, and thrown exception — correlate it all under one
**batch** via `AsyncLocalStorage`, store it through a pluggable provider, and
expose it through a headless API plus an optional dashboard. It's the missing
Telescope for NestJS, designed framework-idiomatically rather than ported.

![The Telescope Overview: stat cards, server vitals, the Telescope health card, and throughput / per-type area charts](./website/public/screenshots/overview.png)

## Quick start

**1. Install** core and the dashboard:

```bash
pnpm add @dudousxd/nestjs-telescope @dudousxd/nestjs-telescope-ui
```

**2. Import** two modules. Request and exception capture wire themselves
automatically, and a zero-config SQLite store is on by default:

```ts
import { Module } from '@nestjs/common';
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { TelescopeUiModule } from '@dudousxd/nestjs-telescope-ui';

@Module({
  imports: [
    TelescopeModule.forRoot({
      prune: { after: '24h' },
      // Required in production, where the console otherwise answers 403 (see below):
      // authorize: (ctx) => ctx.switchToHttp().getRequest().user?.isAdmin === true,
    }),
    TelescopeUiModule.forRoot(/* { authorize } too */),
  ],
})
export class AppModule {}
```

Boot, then open **`/telescope`** for the dashboard or hit
`GET /telescope/api/entries/:id` for a request and everything it caused. Most
apps are done in under five minutes — see the
[Getting Started guide](https://davidecarvalho.github.io/nestjs-telescope/docs/getting-started).

## What you get

| Feature | What it does |
|---------|--------------|
| **Watchers** | Request, query, job, mail, cache, schedule, HTTP-client, and exception capture — correlated under one batch in capture order. |
| **Queue console** | A Horizon-style live view of BullMQ and SQS queues: per-state depth, individual jobs, and (with `mutations: true`) retry / remove / promote / redrive. |
| **Pulse** | At-a-glance health: per-type counts, slowest entries, top exceptions, N+1 hotspots, and a throughput sparkline — rolled up from captured entries. |
| **Health & overhead** | Capture runs *off* the response path; the dashboard surfaces Telescope's own host-path µs/capture, buffer pressure, and flush p95 on a `/health` card. |
| **Storage adapters** | A pluggable `StorageProvider` SPI with a self-healing schema: SQLite by default, swap in Redis (multi-instance) or your own. Per-type retention + an `archive.sink` to ship doomed entries to S3 before prune. |
| **Error alerting** | A genuinely *new* exception family pages you — Slack (Block Kit, route/user, deep link), a raw webhook, or a custom sink — plus rate, slow-route, and dropped-entry rules. |
| **AI diagnosis** | `@dudousxd/nestjs-telescope-ai` turns an exception into a probable-cause / suggested-fix report (Bedrock, OpenAI, any AI-SDK model). On-demand button or auto-mode that enriches the Slack alert. |
| **Frontend errors** | An opt-in public endpoint records browser `client_exception` reports through the same pipeline — family hashing, alerts, archive, dashboard. |
| **Request replay** | Re-issue a captured request against the local app from the dashboard (a mutation, so it needs `mutations: true`); replayed calls carry an `x-telescope-replay: 1` header and a `replay` tag. |
| **MCP server** | A stateless JSON-RPC MCP endpoint lets coding agents (Claude Code, Cursor, …) query the captured data directly — list entries, pull a batch waterfall, read the health snapshot, diagnose an exception. |
| **Overload protection** | Watches event-loop lag and auto-pauses capture under pressure, resuming when the loop recovers — a telescope under load can never amplify an incident (on by default). |
| **One `authorize` option** | A function, an injectable class, a lazy import, an `@nestjs/authorization` policy or a gate name decides who opens the console; without it, production answers 403. |

## Dashboard

```ts
import { TelescopeUiModule } from '@dudousxd/nestjs-telescope-ui';
// imports: [TelescopeModule.forRoot(), TelescopeUiModule.forRoot()]
```

A bundled React SPA served by a NestJS module — no frontend dependency imposed
on your app. Open any request to see its **correlated batch**: a waterfall of
the cache reads, queries, jobs, and exceptions it caused, alongside the request
itself.

See [Protecting the routes](#protecting-the-routes) below.

![A request detail: the batch timeline waterfall, the correlated batch panel, and the request payload](./website/public/screenshots/request-detail.png)

## MCP server

Let a coding agent debug straight from the captured data. With `mcp` enabled,
Telescope serves a stateless JSON-RPC [Model Context Protocol](https://modelcontextprotocol.io)
server (streamable-HTTP) at `<path>/api/mcp`, so an agent can answer
*"why is `POST /checkout` slow?"* by pulling the batch waterfall with every query
it ran — backed by the same storage/stats/diagnosis APIs as the dashboard.

```ts
TelescopeModule.forRoot({
  mcp: true, // omit (or false) and the handler answers 404 (after the access check)
});
```

Register it with Claude Code:

```bash
claude mcp add --transport http telescope http://localhost:3000/telescope/api/mcp
```

Tools exposed: `list_entries` (filter by type/search/tag/time window),
`get_entry` (one entry + its full batch), `get_batch`, `get_stats` (the last-hour
health snapshot), and `diagnose_exception` (AI diagnosis, when `ai` is
configured). It is protected like every console route, by `authorize`.

Agent clients send `Authorization: Bearer <key>`, not your session cookie, so
give the MCP route its own check with `mcpAuthorize` (it replaces `authorize`
on that route only):

```ts
TelescopeModule.forRoot({
  mcp: true,
  authorize: { policy: ConsolePolicy, ability: 'view' },
  mcpAuthorize: authorizeByToken({ token: process.env.TELESCOPE_MCP_TOKEN }),
});
```

```bash
claude mcp add --transport http telescope https://app.example.com/telescope/api/mcp \
  --header "Authorization: Bearer $TELESCOPE_MCP_TOKEN"
```

## Protecting the routes

Telescope has no login of its own: sign-in stays your app's. One option,
`authorize`, decides who may use the console. It runs after your app's
authentication (global guards and `decorators`), so `request.user` is set, and
takes one of five forms:

```ts
TelescopeModule.forRoot({
  authorize: (ctx) => ctx.switchToHttp().getRequest().user?.isAdmin === true,
  // authorize: ConsoleAccess,                              // @Injectable() implements ConsoleAuthorizer
  // authorize: () => import('./console-access.js'),        // lazy, default export
  // authorize: { policy: ConsolePolicy, ability: 'view' }, // @nestjs/authorization
  // authorize: 'console.telescope',                        // gate name (@dudousxd/nestjs-authz)
});
TelescopeUiModule.forRoot({ authorize: /* the same */ });
```

It covers the API, the live stream and the MCP endpoint (`mcpAuthorize`
replaces it on MCP alone); pass the same value to the UI module, which serves
the page. Return `true`/`false`, `{ allowed: false, reason: 'unauthenticated' }`
(401) or `{ redirectTo: '/login' }` (302 for the page, 401 with `redirectTo`
for the API; the dashboard follows it). Denials answer
`{ "error": "forbidden" }` (403) or `{ "error": "unauthenticated" }` (401); a
throw denies.

For header-based callers (coding agents, Prometheus), `authorizeByToken`
checks `Authorization: Bearer <token>` in constant time:

```ts
TelescopeModule.forRoot({
  mcp: true,
  authorize: { policy: ConsolePolicy, ability: 'view' },
  mcpAuthorize: authorizeByToken({ token: process.env.TELESCOPE_MCP_TOKEN }),
});
```

**Without `authorize`** the console is open outside production; with
`NODE_ENV === 'production'` every request answers 403 and one warning is logged
at boot. `decorators` (authentication, throttling, ...) still run first but
don't count as access control on their own. The same rule covers the otel
`GET /metrics` scrape (`forExporter(exporter, { authorize })`).

**Mount the routes yourself.** `routes: false` mounts no controller (capture,
storage, watchers and every service keep running) and the module exports what
the controllers need. Extend the exported controllers and protect them with
`@UseConsoleAuthorize()`, the same contract. With no argument it runs the
module's `authorize`; list it ABOVE your auth guard (Nest applies class
decorators bottom-up, so the auth guard runs first and sets `request.user`):

```ts
@Controller('ops/telescope/api')
@UseConsoleAuthorize()
@UseGuards(AuthGuard)
class ConsoleApi extends TelescopeController {}

@Controller('ops/telescope')
@UseConsoleAuthorize()
@UseGuards(AuthGuard)
class ConsolePage extends TelescopeUiController {}

@Module({
  imports: [
    TelescopeModule.forRoot({
      path: 'ops/telescope',
      routes: false,
      authorize: { policy: ConsolePolicy, ability: 'view' },
    }),
    TelescopeUiModule.forRoot({ path: 'ops/telescope', routes: false }),
  ],
  controllers: [ConsoleApi, ConsolePage],
})
export class OpsModule {}
```

`StreamController`, `TelescopeMcpController` and `ClientErrorController` extend
the same way. Keep `path` set to where you mount them, since the request
capture skips the console's own calls and the page rebases its assets on it.
Every mounted controller is also marked open to `@nestjs/authorization`'s
deny-by-default global guard (`Can.Anyone()`), so `authorize` decides; a
`Can(...)` in `decorators` is still enforced.

**Public by design: the client-error beacon.** `POST <path>/api/client-errors`
(off until `clientErrors.enabled`) takes reports from any visitor's browser, so
it takes neither `decorators` nor `authorize`. It keeps its byte cap and per-IP
rate limit. To put it behind your own auth, use `routes: false` and extend
`ClientErrorController`.

**Mutations** (queue retry/remove/promote/redrive/enqueue, prune, replay,
profiling) are a feature switched on with `mutations: true` (off: 403). Who may
call them is decided by `authorize` like every other route; for a stricter
rule on mutations, mount the routes yourself and override those methods with an
extra `@Can(...)` (re-declare the route decorators on the override).

## Links

- **Documentation** — https://davidecarvalho.github.io/nestjs-telescope
- **Example app** — [`examples/basic-app`](./examples/basic-app) boots with zero
  config and fills its own dashboard while you watch.
- **Recipes** — [custom storage](https://davidecarvalho.github.io/nestjs-telescope/docs/recipes/custom-storage),
  [custom watcher](https://davidecarvalho.github.io/nestjs-telescope/docs/recipes/custom-watcher),
  [protecting the routes](https://davidecarvalho.github.io/nestjs-telescope/docs/dashboard/auth),
  [tags & redaction](https://davidecarvalho.github.io/nestjs-telescope/docs/recipes/tags-and-redaction),
  [archiving to S3](https://davidecarvalho.github.io/nestjs-telescope/docs/recipes/archiving-exceptions-to-s3),
  [reporting frontend errors](https://davidecarvalho.github.io/nestjs-telescope/docs/recipes/reporting-frontend-errors),
  [AI exception diagnosis](https://davidecarvalho.github.io/nestjs-telescope/docs/recipes/ai-exception-diagnosis).
- **Architecture** — [`DESIGN.md`](./DESIGN.md) · **Product brief** — [`PRODUCT.md`](./PRODUCT.md)

## Packages

| Package | What it is |
|---------|------------|
| `@dudousxd/nestjs-telescope` | Core: request + exception watchers, recorder, ALS correlation, SQLite store, headless API, pruner |
| `@dudousxd/nestjs-telescope-ui` | Bundled dashboard SPA + composable React components / hooks / client |
| `@dudousxd/nestjs-telescope-mikro-orm` | MikroORM query watcher + N+1 detector |
| `@dudousxd/nestjs-telescope-typeorm` | TypeORM query watcher (host-wired logger) |
| `@dudousxd/nestjs-telescope-prisma` | Prisma query watcher (`$on('query')`) |
| `@dudousxd/nestjs-telescope-bullmq` | BullMQ job watcher: per-job capture + correlation |
| `@dudousxd/nestjs-telescope-mail` | Mail watcher (nodemailer `sendMail`) |
| `@dudousxd/nestjs-telescope-cache` | Cache watcher (get/set hit/miss) |
| `@dudousxd/nestjs-telescope-schedule` | Schedule watcher (`@nestjs/schedule` cron/interval) |
| `@dudousxd/nestjs-telescope-events` | Event watcher (`@nestjs/event-emitter`) |
| `@dudousxd/nestjs-telescope-logs` | Log watcher (Nest `Logger` output) |
| `@dudousxd/nestjs-telescope-redis-watcher` | Redis command watcher (wrapped `ioredis`) |
| `@dudousxd/nestjs-telescope-mikro-orm-watcher` | Model watcher (MikroORM entity lifecycle changes) |
| `@dudousxd/nestjs-telescope-redis` | Redis-backed shared storage (multi-instance) |
| `@dudousxd/nestjs-telescope-parquet` | Tiered storage: a hot store plus a cold Parquet tier on S3 or disk |
| `@dudousxd/nestjs-telescope-clickhouse` | ClickHouse storage with TTL retention and pre-aggregated rollups |
| `@dudousxd/nestjs-telescope-sqs` | SQS live-queue manager (depth + DLQ inspection + redrive) |
| `@dudousxd/nestjs-telescope-ai` | AI exception diagnoser (Vercel AI SDK — Bedrock, OpenAI, any model) |
| `@dudousxd/nestjs-telescope-otel` | OpenTelemetry trace-context provider + bridge |
| `@dudousxd/nestjs-telescope-official` | NestJS first-party packages: resilience, workflows, authentication, authorization and mail channel events; `@nestjs/ai` usage; `@nestjs/observe` trace ids |
| `@dudousxd/nestjs-telescope-testing` | In-memory store, `FakeClock`, watcher test harness |

## License

MIT © Davi Carvalho
