# Design — `@dudousxd/nestjs-telescope`

A Laravel Telescope-style observability console for NestJS. Watchers capture what
happens inside a request (and inside queue jobs, scheduled commands, CLI runs),
correlate it all under one batch, and expose it through a headless API and an
optional dashboard. Built robust-first: the capture pipeline is non-blocking and
backpressure-safe, storage and watchers are pluggable, and it runs in both dev
(rich capture) and production (redaction, gating, aggressive pruning).

> This document is the architectural contract. It is intentionally complete
> rather than minimal — the public SPIs described here are what the community
> extends, so they are designed up front, not grown ad hoc.

---

## 1. Mental model

```
                          ┌──────────────────────────── AsyncLocalStorage ───────────────────────────┐
                          │  Batch { id, origin, startedAt }  — one per entry-point (request/job/cmd) │
                          └──────────────────────────────────────────────────────────────────────────┘
   entry-point watchers          sub-watchers (run inside the active batch)
   ┌──────────────┐   ┌───────────────┬──────────────┬──────────────┬─────────────┐
   │ RequestWatcher│  │ QueryWatcher  │ MailWatcher  │ JobWatcher*  │ Exception   │  ... custom
   │ JobWatcher    │  │ HttpClient    │ Cache/Event  │              │ Watcher     │
   │ ScheduleWatch │  └───────┬───────┴──────┬───────┴──────┬───────┴─────┬───────┘
   └──────┬────────┘          │              │              │             │
          │                   ▼              ▼              ▼             ▼
          └──────────────►  Recorder  (async, bounded, backpressure-safe pipe)
                              │   stages: enrich → tag → redact → sample → batch-buffer → flush
                              ▼
                         StorageProvider   (default: SQLite | adapters: mikro-orm / typeorm / prisma / redis)
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
       Headless API      OTel bridge        Pruner (scheduled retention)
       /telescope/api    (export+ingest)
            │
            ▼
       @dudousxd/nestjs-telescope-ui  (optional dashboard SPA)
```

`*` Some watchers are **entry-points** (they open a batch: HTTP request, queue job,
scheduled command, manual `Telescope.batch()`), others are **sub-watchers** (they
record into whatever batch is active). The same watcher can do both — e.g. the
JobWatcher opens a batch when a worker picks up a job, and records a child entry
when code dispatches a job mid-request.

---

## 2. Core abstractions (public SPI)

These four interfaces are the entire extension surface. Everything built-in is
implemented against them, so a third-party watcher or store is a first-class
citizen, not a second-class hook.

### 2.1 `Entry`

The universal record. Type-specific data lives in `content`; everything else is
uniform so the API, UI, pruner, and OTel bridge treat all entry types the same.

```ts
interface Entry<TContent = unknown> {
  id: string;            // uuid v7 — time-sortable, globally unique
  batchId: string;       // correlation key; all entries in one batch share it
  type: string;          // 'request' | 'query' | 'job' | 'exception' | 'mail' | <custom>
  familyHash: string | null; // groups "the same thing" (query template, exception class+message)
  content: TContent;     // redacted, type-specific payload
  tags: string[];        // cross-cutting filters: 'status:500', 'user:42', 'slow'
  sequence: number;      // order within the batch (capture order)
  durationMs: number | null;
  origin: BatchOrigin;   // 'http' | 'queue' | 'schedule' | 'cli' | 'manual'
  instanceId: string;    // hostname/pod id — multi-instance aggregation
  createdAt: Date;
}
```

`familyHash` powers "show me every occurrence of this exception" and the
slow-query/duplicate-query views without scanning content.

### 2.2 `Watcher`

```ts
interface Watcher {
  readonly type: string;            // entry type it produces
  register(ctx: WatcherContext): void | Promise<void>;  // wire NestJS hooks
  shouldRecord?(candidate: unknown): boolean;           // cheap pre-filter
}

interface WatcherContext {
  record(input: RecordInput): void;        // hand an entry to the Recorder (fire-and-forget)
  beginBatch(origin: BatchOrigin): BatchHandle; // entry-point watchers open a batch
  config: ResolvedTelescopeConfig;
  // access to the Nest container for adapter-specific wiring:
  moduleRef: ModuleRef;
}
```

Watchers never touch storage and never block. They call `record()`, which returns
immediately.

**Committed watcher roster:**
- *v1 (NestJS-integration plan):* **Request, Exception** (the runnable foundation),
  then **Job, Mail, Query**.
- *Expanded roster (follow-on plans):* **HttpClient** (outbound axios/undici),
  **Cache** (cache-manager hits/misses), **Gate** (authz allow/deny on
  guards/policies), **Dumps** (`dd()`-style debug dumps on the timeline),
  **Schedule** (`@nestjs/schedule` cron ticks as their own batches), **Model**
  (MikroORM/TypeORM entity hydration — feeds N+1 detection).

All built on the same `Watcher` SPI; community watchers are first-class.

### 2.3 `StorageProvider`

```ts
interface StorageProvider {
  store(entries: Entry[]): Promise<void>;        // batch write
  update(id: string, patch: Partial<Entry>): Promise<void>; // request entry completes
  find(id: string): Promise<EntryWithBatch | null>;
  get(query: EntryQuery): Promise<Page<Entry>>;  // filter by type/tag/batch/family/time
  batch(batchId: string): Promise<Entry[]>;      // the correlation view
  tags(prefix?: string): Promise<TagCount[]>;
  prune(olderThan: Date, keepLast?: number): Promise<number>;
  clear(): Promise<void>;
}
```

- **Default (in core):** `SqliteStorageProvider` (better-sqlite3) — zero-config,
  embedded, perfect for a single instance / local dev.
- **ORM adapters** (`-mikro-orm`, `-typeorm`, `-prisma`): persist into the host
  app's database, reusing its connection and migrations. These packages also
  ship the matching **QueryWatcher** (they already sit on the ORM's event stream).
- **`-redis` adapter:** shared store with native TTL pruning — the recommended
  store for **multi-instance / multi-pod production**, where per-pod SQLite would
  fragment the view.

### 2.4 `Recorder`

The heart of "robust". A bounded, async, backpressure-safe pipe between watchers
and storage. The application thread never waits on it.

```
record(input)
  → enrich   (attach batchId from ALS, instanceId, sequence, createdAt)
  → tag      (run registered Taggers; built-in + user-provided)
  → redact   (deep-redact configured paths + default sensitive keys)
  → sample   (per-type sampling + filter() hook; drop early)
  → buffer   (push to a bounded ring buffer)
  → flush    (drain in batches on a timer / size threshold → StorageProvider.store)
```

Robustness guarantees:
- **Non-blocking:** `record()` is synchronous and O(1); all I/O is deferred.
- **Bounded memory:** ring buffer has a hard cap; on overflow it drops oldest and
  increments a `telescope_dropped_total` counter (never grows unboundedly, never
  blocks the app).
- **Batched writes:** flushes coalesce many entries into one `store()` call.
- **Graceful shutdown:** `onApplicationShutdown` drains the buffer with a timeout.
- **Failure isolation:** a storage error is logged and the batch is dropped — a
  broken telescope never breaks the host app.

---

## 3. Correlation (the differentiator)

A `TelescopeContext` lives in `AsyncLocalStorage`. Entry-point watchers call
`beginBatch(origin)`, which seeds a `Batch { id, origin, startedAt }` into the
ALS store for the duration of that async flow. Every `record()` made inside that
flow inherits the `batchId` and gets a monotonic `sequence`.

The result is the view Grafana/Prometheus can't give you:

> **Request `GET /orders/42`** → 5 queries (1 flagged slow + 2 duplicates),
> 1 job dispatched (`SendReceipt`), 1 outbound HTTP call, 1 exception.

Non-HTTP entry points get their own batch: a queue worker opens a batch per job,
`@nestjs/schedule` opens one per cron tick, and `Telescope.batch(origin, fn)`
wraps an arbitrary script/CLI run. Entries recorded outside any batch get a
synthetic per-entry batch so nothing is lost.

`traceId`/`spanId` from an active OTel context are captured onto the batch so the
correlation survives the OTel bridge (§6) — a Telescope batch maps 1:1 to a trace.

---

## 4. Configuration

`TelescopeModule.forRoot(options)` / `forRootAsync(...)`. Options are validated
(Zod) and resolved once into a `ResolvedTelescopeConfig` shared with every watcher.

```ts
interface TelescopeModuleOptions {
  enabled?: boolean;                        // master switch; compute inline (e.g. NODE_ENV !== 'production')
  storage?: StorageProvider | StorageFactory; // default: SqliteStorageProvider
  watchers?: WatcherRegistration[];         // built-ins + custom; each individually configurable
  path?: string;                            // RESERVED. v1 serves the API at a fixed '/telescope/api'; a configurable mount path is a follow-up.

  // --- privacy / safety (prod) ---
  redact?: {
    headers?: string[]; query?: string[]; body?: string[];
    jobData?: string[]; mail?: string[];
    keys?: string[];                        // global sensitive-key denylist (merged w/ defaults)
  };
  hideResponses?: boolean;
  ignorePaths?: (string | RegExp)[];
  ignoreCommands?: string[];

  // --- volume control ---
  sampling?: number | Partial<Record<string, number>>; // global or per-type rate 0..1
  filter?: (entry: Entry) => boolean;       // final allow/deny hook
  recorder?: { bufferSize?: number; flushIntervalMs?: number; flushBatchSize?: number };

  // --- retention ---
  prune?: { after: Duration; keepLast?: number; intervalMs?: number };

  // --- access control (API + UI) ---
  authorizer?: (ctx: AuthorizerContext) => boolean | Promise<boolean>; // default: deny in production

  // --- distributed tracing ---
  otel?: { export?: boolean; ingest?: boolean };

  // --- extensibility ---
  taggers?: Tagger[];
}
```

Env-awareness is just configuration: a typical app enables rich capture with a
permissive authorizer in dev, and in prod sets `enabled` behind a flag, a strict
`authorizer`, full `redact`, low `sampling`, and `prune.after`.

---

## 5. HTTP surface (headless)

The core registers a controller at a fixed base `/telescope/api` (a configurable
`path` is a follow-up):

| Route | Purpose |
|-------|---------|
| `GET  /telescope/api/entries` | filter by `type`, `tag`, `familyHash`, `batchId`, time, cursor-paginated |
| `GET  /telescope/api/entries/:id` | single entry + its full batch (the correlation view) |
| `GET  /telescope/api/batches/:id` | all entries in a batch, ordered by `sequence` |
| `GET  /telescope/api/tags` | tag facets for the filter UI |
| `DELETE /telescope/api/entries` | manual clear (gated) |
| `GET  /telescope/api/meta` | enabled watchers, dropped counter, storage health |

Every route runs through `TelescopeGuard`, which calls the configured
`authorizer`. **Default behavior is deny when `NODE_ENV === 'production'`** until
the host explicitly provides an authorizer — the same safe default Telescope uses.

The API is the only contract the UI depends on, so the dashboard is fully
decoupled and replaceable.

---

## 6. OpenTelemetry bridge (`-otel`, bidirectional)

- **Export:** a `SpanProcessor`/exporter maps each batch → a trace and each entry
  → a span (`telescope.<type>`), so entries land in Tempo/Jaeger alongside the
  rest of the app's traces. Batch `traceId` is reused when an OTel context is
  already active, keeping a single trace.
- **Ingest:** a `TelescopeSpanProcessor` converts incoming OTel spans → entries,
  so existing OTel instrumentation (DB, HTTP, gRPC) shows up in the console
  without a dedicated watcher.

The bridge is a separate package and a no-op unless `otel.export`/`otel.ingest`
are enabled, keeping `@opentelemetry/*` out of core's dependency graph.

---

## 7. The optional dashboard (`-ui`)

A standalone SPA (built assets shipped in the package) that the core can serve at
`path`, or that can be hosted anywhere and pointed at the API. It renders:
the entry list with live tail and faceted filters; the **batch/correlation view**;
type-specific detail panels (SQL with bindings, request/response, stack traces,
mail preview, job payload + attempts); and family rollups (recurring exceptions,
slow/duplicate queries). Detail panels are registered through a small renderer
registry so custom entry types can ship their own panel.

The UI is strictly a client of §5. Choosing not to install it loses nothing but
the visuals.

---

## 8. Package layout

```
packages/
  core/       @dudousxd/nestjs-telescope          Entry/Watcher/StorageProvider/Recorder, ALS,
                                                   TelescopeModule, config, default SQLite store,
                                                   Request/Job/Exception/Mail watchers, HTTP API, pruner
  mikro-orm/  @dudousxd/nestjs-telescope-mikro-orm QueryWatcher + StorageProvider (MikroORM)
  typeorm/    @dudousxd/nestjs-telescope-typeorm   QueryWatcher + StorageProvider (TypeORM)
  prisma/     @dudousxd/nestjs-telescope-prisma    QueryWatcher + StorageProvider (Prisma)
  redis/      @dudousxd/nestjs-telescope-redis     StorageProvider (shared, TTL-pruned, multi-instance)
  otel/       @dudousxd/nestjs-telescope-otel      bidirectional OpenTelemetry bridge
  pulse/      @dudousxd/nestjs-telescope-pulse     aggregate health dashboard (Pulse-mode): cards over the entry stream
  ui/         @dudousxd/nestjs-telescope-ui        dashboard SPA + agnostic serve controller (Express + Fastify)
  testing/    @dudousxd/nestjs-telescope-testing   re-exports core's InMemoryStorageProvider + fake clock + watcher test harness
examples/     runnable apps (express + fastify, each ORM)
integration/  cross-package integration suites (real ORMs against SQLite/Postgres/MySQL)
website/      docs site
```

Internal deps use `workspace:*`; everything is `peerDependency` against
`@nestjs/*` so the host owns the framework version.

---

## 9. Cross-cutting concerns

- **Performance:** capture cost is one ALS read + one object push. No serialization
  or redaction happens on the request thread — it's deferred to the flush stage.
- **Security/PII:** redaction runs before anything is persisted; a default
  denylist (`authorization`, `cookie`, `password`, `token`, `secret`, `api-key`, …)
  is always applied and merged with user config. Responses hidden by default for
  non-2xx auth-sensitive routes via `hideResponses`.
- **Multi-instance:** `instanceId` on every entry; shared stores (Redis / app DB)
  aggregate across pods; SQLite is documented as single-instance.
- **Failure isolation:** every watcher hook and the Recorder are wrapped so a
  telescope bug can never throw into the host app's request path.
- **Graceful shutdown:** buffer drains on shutdown with a bounded timeout.
- **Testability:** `-testing` ships an in-memory store, a controllable clock, and
  a harness that drives a watcher and asserts emitted entries — so watchers are
  unit-tested without a running Nest app.

---

## 10. Extensibility contracts (what the community builds)

1. **Custom watcher:** implement `Watcher`, register in `watchers: [...]`. Gets the
   same Recorder, ALS correlation, redaction, and UI detail-panel slot as built-ins.
2. **Custom storage:** implement `StorageProvider`, pass as `storage`. The default
   SQLite store is itself just an implementation — no privileged path.
3. **Custom entry type + UI panel:** register a `type` string and an optional UI
   renderer; the API, pruner, and OTel bridge handle it generically.
4. **Taggers:** `(entry) => string[]` functions that enrich entries with searchable
   tags without modifying watchers.

---

## 11. Platform support — Express AND Fastify

NestJS runs on `@nestjs/platform-express` or `@nestjs/platform-fastify`; the library
must be agnostic to both.

- **HTTP API + guard** are plain Nest controllers/guards — they work on either
  adapter unchanged.
- **RequestWatcher** reads request data through `ExecutionContext.switchToHttp()`,
  but the raw fields differ (`req.originalUrl` vs `req.url`, `req.ip` vs
  `req.socket.remoteAddress`, header/body access). A small **`PlatformRequest`
  adapter** normalizes these, selected via `HttpAdapterHost`. Never import
  `express`/`fastify` types into core watcher logic.
- **UI serving** (`-ui`) cannot use `express.static`/`@fastify/static` directly.
  The dashboard assets are streamed through a Nest controller (`Readable` →
  response), which both adapters handle.
- **Tests** run the RequestWatcher + API against both an Express and a Fastify
  Nest app to lock parity.

`@nestjs/platform-express`/`-fastify` are `peerDependency` + `peerDependenciesMeta.optional`
so neither is forced on the host.

---

## 12. Strategic features beyond per-entry browsing

These are committed roadmap bets (each its own plan, layered on the spine + watchers):

- **Pulse-mode (`-pulse`)** — an aggregate **health dashboard** of cards computed
  over the entry stream: slowest requests/queries/jobs, top exceptions by family,
  active users, cache hit rate, error rate. This is the "admin analytics about the
  platform" surface; it complements (doesn't replace) the per-entry Telescope view.
  Backed by periodic rollups over storage so cards are cheap to render.
- **N+1 detector + query insights** — within a batch, group `query` entries by
  `familyHash`; when one template runs more than a threshold, emit an **insight**
  (a tagged synthetic entry / Pulse card) flagging the likely N+1, with the
  offending SQL and the parent request. The Model watcher's hydration data sharpens
  this.
- **Horizon-style queue metrics** — over the Job watcher (BullMQ + SQS): throughput,
  wait time, runtime percentiles, retries, and failure rate per queue, as a
  dedicated dashboard view. The Job watcher records the lifecycle; this aggregates it.

**Deferred (not in current roadmap):** AI-assisted triage (a `-ai` package using
Claude to explain/cluster exceptions and slow batches) — revisit after the above land.

Other differentiators kept in mind but unscheduled: trace-waterfall view of a batch,
request replay, entity-change diffs, threshold→Slack alerting, multi-instance
aggregation (the data model already carries `instanceId`).
