# @dudousxd/nestjs-telescope

Core of [`@dudousxd/nestjs-telescope`](../../README.md) — request + exception
watchers, the recorder, ALS-based batch correlation, the SQLite store, the
headless API, the dashboard guard, and the pruner. See the root
[`README.md`](../../README.md) for the quick start.

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
prune on demand. Pruning is a **mutation**, so it sits behind the same
default-deny `authorizeAction` gate as the queue console: `403` until you supply
that callback, `400` when no `prune` window is set. The Overview **Retention**
card shows a *Prune now* button only when both are in place (`meta.pruneEnabled`).

## Alerts (webhook)

Telescope can POST a JSON alert to a webhook when a rule trips. It's
**webhook-only** (v1) and runs on an unref'd interval — a failing webhook is
logged once per rule kind and **never** crashes the host.

```ts
TelescopeModule.forRoot({
  alerts: {
    webhookUrl: process.env.SLACK_WEBHOOK_URL, // any endpoint that accepts a JSON POST
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

A configured `alerts` with an empty `webhookUrl` or empty `rules` is a
**fail-closed boot error**. The POSTed payload is:

```json
{ "rule": { "...": "..." }, "value": 12, "threshold": 10, "firedAt": "2026-06-04T00:00:00.000Z", "instanceId": "host-1" }
```

For Slack, point `webhookUrl` at an incoming-webhook URL; the raw payload lands
as the message body (wrap it in your own relay if you want a formatted message).
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
hits the app (it may write), so it's a **mutation**: it sits behind the same
default-deny `authorizeAction` gate as prune / queue actions (`403` until you
supply that callback), not the read `authorizer`. The replayed request carries an
`x-telescope-replay: 1` header (so the host can recognize or skip it) and strips
cookie/authorization/host headers — a replay must not silently reuse the captured
session. Replayed requests are tagged `replay`. The dashboard's request detail
exposes a *Replay* button when `authorizeAction` is configured.

## MCP server (coding agents)

With `mcp` enabled, Telescope serves a **stateless JSON-RPC** [Model Context
Protocol](https://modelcontextprotocol.io) server over streamable HTTP at
`POST /telescope/api/mcp`, so a coding agent (Claude Code, Cursor, …) can debug
straight from the captured data — backed by the same storage/stats/diagnosis APIs
as the dashboard. JSON-RPC is hand-rolled (no SDK dependency); being stateless,
the transport's `GET` stream returns `405` and `DELETE` is a `200` no-op.

```ts
TelescopeModule.forRoot({
  mcp: true,                                       // dev-only: open when NODE_ENV !== 'production'
  // mcp: { token: process.env.TELESCOPE_MCP_TOKEN }, // require a Bearer token (only way to expose in prod)
  // mcp: false                                       // (or omitting it) disables the endpoint
});
```

Register it with Claude Code:

```bash
claude mcp add --transport http telescope http://localhost:3000/telescope/api/mcp
```

Tools: `list_entries` (filter by type/search/tag/time window), `get_entry` (one
entry + its full batch), `get_batch`, `get_stats` (last-hour health snapshot), and
`diagnose_exception` (AI diagnosis, when `ai` is configured). Auth is enforced by
the controller (no dashboard guard): with a `token`, every request must carry
`Authorization: Bearer <token>`; without one the endpoint is allowed only when
`NODE_ENV !== 'production'`, and a tokenless config in production is refused.
