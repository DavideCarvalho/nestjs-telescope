# nestjs-telescope — basic-app example

A tiny NestJS app that boots **`@dudousxd/nestjs-telescope`** with zero config and
**fills its own dashboard** while you watch. The 30-second onboarding artifact.

## Run it

From the repo root:

```bash
pnpm install
pnpm --filter example-basic-app dev
```

Then open **<http://localhost:3000/telescope>**.

That's it. A built-in traffic seeder fires ~4 requests/second against the app's
own endpoints the moment it boots, so the dashboard fills up on its own — give it
about 30 seconds.

## What you'll see

- **Overview** — request throughput, latency percentiles, and an error-rate card.
  A slice of orders intentionally 500 (a barista "drops the cup" ~1 in 10, plus a
  few bad-input requests), so the error charts have something to show.
- **Entries** — live requests, queries, cache hits/misses, exceptions, and dumps
  as they happen. Filter by type to drill in.
- **Queries** — ORM-logger-shaped records (`{ sql, bindings, took }`) from the
  menu lookups and order inserts, grouped by query family.
- **Cache** — per-request hit/miss events emitted by a custom `CacheWatcher`
  source (menu and loyalty lookups).
- **Dumps** — each placed order is `telescopeDump()`'d and correlated to the
  request that produced it.
- **Traces** — click any request to see its correlated queries, cache events,
  dumps, and exceptions in one batch.
- **Health card** — the recorder/storage health summary on the Overview page.

## The endpoints

| Method | Path            | What it does                                          |
| ------ | --------------- | ----------------------------------------------------- |
| `GET`  | `/coffee/menu`  | A cached menu read (occasional miss → a query).        |
| `POST` | `/coffee/order` | Places an order: queries, a cache lookup, a dump, varied latency, and an occasional thrown exception. |

Try it yourself while the seeder runs:

```bash
curl http://localhost:3000/coffee/menu
curl -X POST http://localhost:3000/coffee/order \
  -H 'content-type: application/json' \
  -d '{"drink":"cortado","shots":2}'
```

## How it's wired

Everything lives in [`src/app.module.ts`](./src/app.module.ts):

```ts
TelescopeModule.forRoot({
  watchers: [new CacheWatcher(cacheHolder.source())],
}),
TelescopeUiModule.forRoot(),
```

`TelescopeModule.forRoot({})` is zero-config — it defaults to an in-memory SQLite
store with the request and exception watchers already on. `TelescopeUiModule`
serves the bundled React dashboard at `/telescope`.

### Want a login wall?

The demo ships dashboard auth **OFF** so the 30-second path stays frictionless.
To gate the dashboard behind a login, uncomment the 5-line `dashboardAuth` recipe
in `src/app.module.ts`.
