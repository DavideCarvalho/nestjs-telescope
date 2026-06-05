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
