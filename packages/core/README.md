# @dudousxd/nestjs-telescope

Core of [`@dudousxd/nestjs-telescope`](../../README.md) — request + exception
watchers, the recorder, ALS-based batch correlation, the SQLite store, the
headless API, and the pruner. See the root
[`README.md`](../../README.md) for the quick start.

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

It covers the API, the live stream and telescope's tools on the dev MCP
endpoint; pass the same value to the UI module, which serves
the page. Return `true`/`false`, `{ allowed: false, reason: 'unauthenticated' }`
(401) or `{ redirectTo: '/login' }` (302 for the page, 401 with `redirectTo`
for the API; the dashboard follows it). Denials answer
`{ "error": "forbidden" }` (403) or `{ "error": "unauthenticated" }` (401); a
throw denies.

For header-based callers (coding agents, Prometheus), `authorizeByToken`
checks `Authorization: Bearer <token>` in constant time:

```ts
TelescopeModule.forRoot({
  authorize: authorizeByToken({ token: process.env.TELESCOPE_TOKEN }),
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

`StreamController` and `ClientErrorController` extend
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

## Memory bounds

Telescope holds a bounded working set in memory, by design:

```
heap ≈ prune.after × ingest rate × bytes per entry
```

There is no unbounded leak — but the three factors multiply, so a high ingest
rate of fat entries against a generous retention window can still pin a lot of
heap. The library bounds each factor at **capture time** so a host can't drive a
GC death spiral by capturing large content.

### Redaction is also a memory bound

`record()` runs `redact()` synchronously. Besides masking sensitive keys, that
walk is the **detach**: it snapshots content into a plain, reference-free clone,
releasing any live object graph (e.g. a hydrated ORM `req.user` that references
its EntityManager, identity map, and relations). The clone is **bounded** so a
fat graph can't produce a fat entry:

| Bound             | Default | Beyond it                                       |
| ----------------- | ------- | ----------------------------------------------- |
| `maxDepth`        | `8`     | subtree → `'[Truncated: depth]'`                |
| `maxStringLength` | `8_192` | string → first N chars + `'…[truncated]'`       |
| `maxArrayLength`  | `200`   | first N items + `'[Truncated: N of M items]'`   |
| `maxNodes`        | `5_000` | remaining subtrees → `'[Truncated: size]'`      |

The defaults are generous: a normal request / query / cache entry is cloned
byte-identically and never trips a bound. Tune them per app via `redact`:

```ts
TelescopeModule.forRoot({
  redact: {
    keys: ['x-internal-token'],
    maxNodes: 2_000, // tighter cap for very fat content
  },
});
```

> [!WARNING]
> Redaction must stay **synchronous**. Deferring it to the flush dropped capture
> cost but OOM'd a production host: `record()` then only stashed RAW content, so
> up to `bufferSize` live ORM entity graphs were retained until flush. The sync
> clone is load-bearing — it bounds memory by detaching at capture time.

### Down-sample high-volume streams

Sampling is a **store-volume** lever (requests are already off the response
path). Cache hits especially dominate the working-set product, so keep a
fraction of them:

```ts
TelescopeModule.forRoot({
  prune: { after: '1h' },
  sampling: { cache: 0.1 }, // keep 10% of cache entries
});
```

With `prune` set but `sampling` empty, the library logs a one-line INFO at boot
pointing at this recipe.

#### Tail-sampling: keep what matters

A per-type rate can also be a **rule object** to keep a fraction of the noise
while always retaining the entries you'd never want sampled out — errors and
slow ones. Plain-number config is unchanged; the object form is purely additive:

```ts
TelescopeModule.forRoot({
  sampling: {
    cache: { rate: 0.1, keepErrors: true, keepSlowMs: 500 },
  },
});
```

- `rate` — base keep-rate (0–1), applied to ordinary entries of that type.
- `keepErrors` — always keep entries that look like errors: a `failed` tag,
  `content.failed === true`, or `content.statusCode >= 500` (cheap, shallow
  field reads — no deep walk on the hot path).
- `keepSlowMs` — always keep entries whose `durationMs >= keepSlowMs`.

So `{ rate: 0.1, keepErrors: true, keepSlowMs: 500 }` keeps 10% of healthy fast
cache hits but **100%** of failed or ≥500ms ones.

### Watch the `truncated` counter

`GET /telescope/api/health` reports a `truncatedCount`: entries whose content hit
a redaction bound and was clipped. A non-zero, climbing value means a watcher is
capturing fat content (often an ORM entity) — the fix is to project lighter
content (e.g. `req.user` → `{ id, email }`) or tighten `redact` / add `sampling`.
The dashboard's **Overview** health card surfaces the same figure as a *Truncated*
stat.

## Explain slow queries

Telescope is DB-agnostic, so query `EXPLAIN` is an opt-in **host hook** — you
bring the connection and dialect. Supply `explainQuery`, and the dashboard's
query detail grows an **Explain** button (`POST /telescope/api/queries/explain`,
`{ entryId }`) that replays the captured SQL/bindings through your hook and
renders `{ plan }`. The hook runs arbitrary `EXPLAIN <sql>` against your
database, so scope its connection **read-only**. A hook that throws surfaces as a
clean `{ message }` error, not a crash. Hidden when unset (`meta.explainEnabled`).

```ts
TelescopeModule.forRoot({
  explainQuery: async (sql, bindings) => {
    const [rows] = await pool.query(`EXPLAIN FORMAT=JSON ${sql}`, bindings);
    return rows;
  },
});
```

## On-demand prune

With a `prune` retention window configured, `GET /telescope/api/retention`
reports the resolved window and `POST /telescope/api/retention/prune` runs a
prune on demand. Pruning is a **mutation**, so like the queue console it needs
`mutations: true` (`403` otherwise), and `400` when no `prune` window is set. The Overview **Retention**
card shows a *Prune now* button only when both are in place (`meta.pruneEnabled`).

## Alerts

Telescope sends an alert to every configured channel when a rule trips. Rules run
on an unref'd interval; a failing channel is logged and **never** crashes the host.

```ts
import { slackChannel, webhookChannel } from '@dudousxd/nestjs-telescope';

TelescopeModule.forRoot({
  alerts: {
    channels: [
      slackChannel(process.env.SLACK_WEBHOOK_URL!), // formatted Slack message
      webhookChannel('https://relay.example/alerts'), // raw JSON POST
    ],
    every: '1m',       // evaluation cadence (default '1m')
    cooldown: '15m',   // per-rule re-notify suppression (default '15m')
    rules: [
      { type: 'exception-rate', window: '5m', threshold: 10 },
      { type: 'slow-request-rate', window: '5m', thresholdMs: 1000, count: 20 },
      { type: 'dropped-entries', threshold: 100 },
    ],
  },
});
```

- `exception-rate` — fires when `>= threshold` exceptions were recorded in `window`.
- `slow-request-rate` — fires when `>= count` requests slower than `thresholdMs` were recorded in `window`.
- `dropped-entries` — fires when the Recorder's `droppedCount` grew by `>= threshold` since the previous evaluation (a delta).

A configured `alerts` with no `channels` or empty `rules` is a
**fail-closed boot error**. `webhookChannel` POSTs this payload:

```json
{ "rule": { "...": "..." }, "value": 12, "threshold": 10, "firedAt": "2026-06-04T00:00:00.000Z", "instanceId": "host-1" }
```

`meta.alerts` reports `{ enabled, ruleCount }`.

## Overload protection

Telescope watches the process event-loop lag (`perf_hooks.monitorEventLoopDelay`)
on an unref'd interval and **pauses the Recorder** when the p99 lag crosses a
threshold, **resuming** once it recovers — so a telescope under load can never
amplify an incident. While paused, new `record()` calls are dropped. It's **on by
default at 200ms**; degrades to a no-op when `perf_hooks` lacks the monitor.

```ts
TelescopeModule.forRoot({
  overloadProtection: true,                       // default — pause above 200ms p99
  // overloadProtection: { maxEventLoopLagMs: 100 }, // tune the threshold
  // overloadProtection: false,                      // disable entirely
});
```

## Request replay

`GET /telescope/api/entries/:id/replay` re-issues a captured `request` entry
against the local app (`127.0.0.1`) and returns the outcome. Replaying actually
hits the app (it may write), so it's a **mutation**: like prune / queue actions
it needs `mutations: true` (`403` otherwise). The replayed request carries an
`x-telescope-replay: 1` header (so the host can recognize or skip it) and strips
cookie/authorization/host headers — a replay must not silently reuse the captured
session. Replayed requests are tagged `replay`. The dashboard's request detail
exposes a *Replay* button when `mutations: true` is set.

## MCP tools (coding agents)

Telescope has no MCP endpoint of its own. It registers its tools on the Aviary
dev MCP endpoint, `/mcp/aviary`, served by `@dudousxd/nestjs-agent-mcp-server`,
so a coding agent (Claude Code, Cursor, …) can debug straight from the captured
data:

```bash
claude mcp add --transport http aviary http://localhost:3000/mcp/aviary
```

Tools: `telescope_list_entries` (filter by type/search/tag/time window,
`{ items, next }` pages), `telescope_get_entry` (one entry + its batch),
`telescope_get_trace`, `telescope_get_waterfall`, `telescope_get_health`, and
`telescope_diagnose_exception` (AI diagnosis, when `ai` is configured). They are
gated by the console's `authorize`, and registered while the routes are mounted
(`devTools: true` keeps them with `routes: false`, `devTools: false` turns them
off). 4.x's `mcp: true` endpoint at `<path>/api/mcp`, with `mcpAuthorize` and
`mcpDecorators`, was removed in 5.0.

