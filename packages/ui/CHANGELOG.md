# @dudousxd/nestjs-telescope-ui

## 1.7.1

### Patch Changes

- [`895ebf2`](https://github.com/DavideCarvalho/nestjs-telescope/commit/895ebf2adb0342a3c648f5c22b27df94328a08da) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add a **Workflows** nav tab for durable-workflow entries. The dashboard now knows the `durable`
  entry type (recorded by `@dudousxd/nestjs-durable-telescope`'s watcher), so when a host registers
  that watcher the sidebar shows a "Workflows" tab listing every workflow run/step lifecycle event,
  tagged by `workflow:<name>` / `kind:<local|remote|sleep|signal>`. Without the watcher registered the
  tab stays hidden, like every other watcher-driven nav item.

## 1.7.0

### Minor Changes

- [`4a610c3`](https://github.com/DavideCarvalho/nestjs-telescope/commit/4a610c3a3b71d1daa4180da0e92a88a2d7b10472) - Add the Inertia debug panel. The dashboard now renders a rich detail view for
  `inertia` entries (`InertiaBody`): rendered component header with status/partial
  badges, a red version-mismatch (409) callout, the partial-reload Kept/Excluded
  columns, prop classification chips (shared/final/optional/once/merge/deep-merge
  with `matchPropsOn` annotations), deferred groups, the resolved-props tree
  (showing the Recorder's redaction/truncation markers verbatim), history flags and
  page size. Adds `InertiaBadge` (409 / partial / deferred / size chips), an
  `inertia` list summary, and an `Inertia` nav tab that self-hides until the
  `InertiaWatcher` is installed.

### Patch Changes

- [`10c76f1`](https://github.com/DavideCarvalho/nestjs-telescope/commit/10c76f1c0d9c1034e5bffca2d9775cd16e553200) - Inertia panel polish: log on record failure (was silently swallowed) and warn once on
  an unsupported diagnostic version; collapse `InertiaContent` to
  `Omit<InertiaRenderDiagnostic, …>` with a destructure-rest copy; make the
  `isInertiaDiagnostic` guard honest about what it proves; render the Inertia badge in
  the entries table (parity with the cache badge); data-drive the props rows. Adds a
  committed cross-repo wire-contract fixture (`inertia-render.v1.json`) so producer
  drift fails a test.

## 1.6.0

## 1.5.0

### Minor Changes

- [`9e1f318`](https://github.com/DavideCarvalho/nestjs-telescope/commit/9e1f318ba876f3aaf066168b6f8feaa8e20ea5c6) - Fix Slack "Open in Telescope" deep links, and surface cached AI diagnoses on the exception detail page.

  **Slack deep link landed on an empty page.** The "Open in Telescope" button built `<dashboard>#/entries/<type>/<id>`, but `#/entries/<type>` matches the SPA's type-scoped **list** route (`#/entries/:type`) — so the trailing id was ignored and the recipient saw an empty filtered list instead of the entry. The link now points at the real entry-**detail** route, `#/entries/view/:id`, which renders the same `EntryPage` for both `exception` and `client_exception` entries.

  **Auto-mode diagnosis was invisible on the detail page.** In `auto` mode the AI diagnosis is computed and cached per family at first-seen (and may already have been sent to Slack), yet the exception detail page still showed a bare **Diagnose with AI** button as if nothing existed. Now:

  - **Core** adds a read-only `GET <telescope>/api/exceptions/:id/diagnosis` behind the same dashboard read guard as the POST. It serves `{ markdown, cached: true }` from the per-family cache when present and `204 No Content` when absent. It is strictly side-effect-free — it **never** builds context or calls the diagnoser, so a read costs no model tokens.
  - **UI** `DiagnosePanel` fetches that GET on mount (only when `meta.ai.enabled`). A cached diagnosis renders immediately with the **cached** badge and a **Re-run** (force) action; the **Diagnose with AI** button only appears for families that have not been diagnosed yet. The mount fetch shows a subtle "checking" line rather than flashing the button and then swapping it.

## 1.4.0

### Minor Changes

- [`7878ccc`](https://github.com/DavideCarvalho/nestjs-telescope/commit/7878ccc8ca912fd5fc4102c22a5b1c26331443d7) - AI-powered exception diagnosis.

  New package **`@dudousxd/nestjs-telescope-ai`**: `createAiSdkDiagnoser({ model })` implements core's `ExceptionDiagnoser` SPI using the Vercel AI SDK (`ai` is a peer dependency; the model is provider-agnostic — Bedrock / OpenAI / Anthropic / any AI-SDK `LanguageModel`). It turns a captured exception (class, message, stack), its sibling request (route/method/status/duration), and the request's recent **redacted** SQL into a markdown triage report — probable cause, where to look, a suggested fix, and a confidence rating — bounded by `maxOutputTokens` (default 1024) and a hard 30s timeout.

  Core gains an `ai` option (`{ diagnoser, mode? }`, shape defined in core so core stays AI-SDK-free):

  - **On-demand** (default): `POST <telescope>/api/exceptions/:id/diagnose` (behind the normal dashboard read guard) returns `{ markdown, cached }`. Results are cached per error family (bounded, 24h TTL); `?force=true` bypasses. 404 when AI is off or the entry isn't an exception; 502 (safe message) when the diagnoser fails.
  - **Auto** (`mode: 'auto'`): the first time a new exception family is seen, Telescope runs a fire-and-forget diagnosis on the flush path (never blocking capture) and caches it; a firing `new-exception` alert briefly awaits it and attaches it (Slack renders a "Probable cause (AI)" section). `meta.ai` advertises `{ enabled, mode }`.

  The UI adds a **Diagnose with AI** button on exception / client_exception detail pages (visible when `meta.ai.enabled`), rendering the markdown with loading + error states and a **cached** badge with a re-run (force) action.

- [`bc3a0df`](https://github.com/DavideCarvalho/nestjs-telescope/commit/bc3a0df784f31a82753725d9c5e86d75380fee13) - Client error ingestion — Telescope as the frontend error reporter.

  A new **public** endpoint, `POST <telescope>/api/client-errors`, lets browsers report errors directly to Telescope instead of a hand-rolled reporter. Reports are recorded as `client_exception` entries through the normal pipeline, so they compose with everything: the `new-exception` alert, per-type prune/archive, and the dashboard.

  - **Opt-in & ungated.** Configure via `clientErrors: { enabled, maxBodyBytes?, rateLimit?, authorize? }`. Disabled by default (a public surface is opt-in) — while off the endpoint returns 404. It carries no dashboard guard (ordinary users' browsers hit it).
  - **Untrusted-body validation.** Dependency-free structural validation: `message` required, every other field optional with type checks + length caps (message ≤ 2 KB, stack/componentStack ≤ 16 KB, url/userAgent ≤ 2 KB). Invalid → 400 with no echo of the payload. Over the byte cap → 413.
  - **Per-IP rate limit.** A bounded in-memory token bucket (default 60/min, ~10k IPs with oldest-IP eviction). Over the limit → 429. Per-pod best-effort (the effective limit is `perMinute × pods` in a multi-replica deployment).
  - **`authorize` hook.** Runs first; `false` → 403 (a throw is a fail-closed denial). Lets hosts validate a session cookie/header.
  - **Composes.** Records `type: client_exception` with a family hash from name + message + top stack frame (the server exception interceptor now uses the same scheme, so both sources group identically), the `failed` / `client` / `user:<id>` tags, and the captured client IP. The `new-exception` rule now fires for `client_exception` too, using the browser URL and user-agent in place of a server route.
  - **Dashboard.** A new watcher-driven **Client errors** tab (shown only when `clientErrors` is enabled) with a detail view rendering message, stack, component stack, URL, and user-agent.

  See the new recipe: _Reporting frontend errors_.

## 1.3.0

### Minor Changes

- [`7773e0a`](https://github.com/DavideCarvalho/nestjs-telescope/commit/7773e0ad120d2678a07e9eebc4631a19c5c8e381) - Hide the Traces page from the dashboard nav when the host has no `traceContext`.

  Entries only get a `trace_id` when the host wires a `traceContext` provider, so an app without one had a permanently empty Traces page sitting as a dead nav item. The dashboard now hides that link — mirroring the watcher-driven nav, which already hides entry types whose watcher isn't registered.

  - Core: `GET /api/meta` now returns `tracesEnabled: boolean` (whether a `traceContext` provider was configured).
  - UI: the **Traces** nav item is hidden when `meta.tracesEnabled === false`. Undefined meta (loading, or an older server predating the field) still shows it — no flash-of-hidden-nav and backward-compatible. The `#/traces` route is untouched, so a direct visit still resolves.

- [`8f9b65e`](https://github.com/DavideCarvalho/nestjs-telescope/commit/8f9b65e1b2ec1df664bc173cc76072c6fffdbc59) - Pulse "Slow request hotspots" now require a real slowness threshold.

  Previously the slow-route (and slow-outgoing-HTTP) hotspots were a pure top-N p99 ranking with no floor, so a quiet host surfaced fast routes like `/health` at 18ms as "hotspots" — a false alarm. A route now only counts as a hotspot when its **p99 ≥ `slowRouteMs`** (default `1000`ms, matching the `slow` request-tag threshold and the `HttpClientWatcher` `slowMs` default).

  - Configure via `pulse.slowRouteMs` on `TelescopeModule.forRoot({ pulse: { slowRouteMs } })`.
  - The Overview "Slow requests" stat is now labeled **Slow routes** and means "routes over the slow p99 threshold".
  - The Pulse panel shows a friendly empty state ("No routes over the slow threshold") when nothing qualifies.
  - The "Slowest" entries ranking and N+1 hotspots are unchanged — only slow-ROUTE hotspots gained the threshold.

## 1.2.1

## 1.2.0

### Minor Changes

- [`0ba0c24`](https://github.com/DavideCarvalho/nestjs-telescope/commit/0ba0c24ac68c34ad75fe51775dc7089e308c3126) - Three dashboard improvements:

  - **Criticality-first Overview.** The Overview is reorganized so operational triage sits above the fold: a focused stat row (Requests, **Error rate** = exceptions ÷ requests over the window — red above 5%, Failed jobs, and **Slow requests** = routes over their p99 budget), then Recent failures, a newly-mounted **N+1 query hotspots** card, Slowest, and a **Queues needing attention** card that lists only queues with failed jobs or a large pending backlog (and says "All queues healthy" when clean). Trends and Telescope self-health (throughput, by-type, server, health, retention) move below. All figures derive from data already served by `/pulse` and `/queues` — no new endpoints.
  - **Watcher-driven navigation.** The sidebar Watchers list renders only types whose watcher is registered (from `meta.watchers`); `request` and `exception` always show, direct URLs to hidden types still work, and everything shows while `meta` is loading (no flash of hidden nav).
  - **Dedicated User filter.** The entries filter bar gains a User combobox over the `user:` tag namespace (bare ids + counts); selecting one applies the `tag=user:<id>` filter but renders as a `User: <id>` chip, and a `user:` tag arriving via `?tag=` (the entries-table pivot links) is recognized and shown in the User control instead of the generic tag chip.

## 1.1.0

### Minor Changes

- [`8d91d59`](https://github.com/DavideCarvalho/nestjs-telescope/commit/8d91d59563d731e9125bef65a38651c96ec06e0b) - Gate the dashboard SPA behind `dashboardAuth` when the host enables it.

  On boot the SPA calls `GET /auth/me` and branches three ways:

  - **disabled** (auth not configured → `404`): renders the dashboard exactly as
    before, with no auth UI.
  - **authenticated** (`200`): renders the dashboard plus a **Sign out** button in
    the header (next to the theme/live-tail toggles).
  - **unauthenticated** (`401`): renders an **AuthScreen** chosen from the modes in
    the `401` body — a username/password **Sign in** form (`login` mode, inline
    "Invalid credentials" on failure) or an "Open Telescope from your application"
    instruction card with a **Retry** button (`session`-only mode).

  A `401` from any API call mid-session (expired cookie) flips the app back to the
  AuthScreen automatically. The client gains `auth.me()`/`auth.login()`/
  `auth.logout()`; cookies ride along on the existing same-origin `fetch`, so
  there are no transport changes. With `dashboardAuth` unset, behavior is
  unchanged.

- [`4ceb884`](https://github.com/DavideCarvalho/nestjs-telescope/commit/4ceb8846b7307cf522d841c909d7eaf7fcb1aa4e) - Add retention/prune controls and query EXPLAIN.

  **Retention / prune.** A new `GET /api/retention` reports the configured retention
  window (`entryCount`/`oldestCreatedAt` stay `null` — the storage SPI exposes no
  cheap count/oldest, and Telescope never scans to derive them). `POST /api/retention/prune`
  runs an on-demand prune behind the existing default-deny mutation gate
  (`authorizeAction`); it 403s when mutations are disabled and 400s when no `prune`
  window is configured. The Overview page gains a Retention card with a confirm-gated
  "Prune now" button, shown only when `meta.pruneEnabled` (prune window AND mutations).

  **Query EXPLAIN.** A new host hook
  `explainQuery?: (sql, bindings) => Promise<unknown>` lets the host run an
  engine `EXPLAIN` (it brings its own connection/dialect — e.g. MySQL
  `EXPLAIN FORMAT=JSON`). `POST /api/queries/explain` loads the query entry and
  returns `{ plan }`; a hook throw surfaces as a clean `{ message }`. The query
  entry detail gains an "Explain" button (only when `meta.explainEnabled`) that
  renders the plan JSON with loading/error states.

  `TelescopeMeta` gains `pruneEnabled` and `explainEnabled`.

- [`15e3e90`](https://github.com/DavideCarvalho/nestjs-telescope/commit/15e3e903d82616966342feeb966fbd44ad6a2631) - Add user drill-down: pivot from any request entry to all of a user's activity.

  A new built-in **`userTagger`** (in `BUILTIN_TAGGERS`) tags request entries with
  the authenticated user's identity as `user:<id>`. It reads `content.user`,
  preferring `id`, then `_id` (Mongo), then `email` — cheap property reads gated to
  request entries, never throwing on odd content shapes. Whatever `resolveUser`
  returns becomes a filterable tag.

  The dashboard turns that tag into a one-click pivot, reusing the existing
  indexed-tag filter (no new query dimension): user-tagged rows show a `user:<id>`
  chip in the entries table, and the entry detail view offers **"View all activity
  for this user"**. Both navigate to the all-types entries list pre-filtered by the
  tag (`#/entries?tag=user:<id>`), which the entries page now seeds from the `?tag=`
  query string — the same deep-link mechanism as `?familyHash=`.

### Patch Changes

- [`d200d15`](https://github.com/DavideCarvalho/nestjs-telescope/commit/d200d158f927e6a67396e594b32bfd0a0b3424e4) - Bound memory by design at capture time, fixing a production OOM incident.

  A host hit a GC death spiral at its container limit. There was no unbounded leak:
  the heap was a retained _working set_ — `prune.after × ingest rate × bytes per
entry` — amplified by `redact()` deep-cloning fat enumerable object graphs (a
  host's `req.user` ORM entity → tens-of-KB..MB clones per entry), high-cardinality
  cache capture volume, and the Recorder ring never nulling drained slots (stale fat
  entries lingered up to capacity). The synchronous `redact()` detach is
  load-bearing and must stay synchronous, so the fix bounds the clone instead of
  deferring it.

  - **Bounded redaction (on by default).** `redact()` now applies hard, overridable
    bounds: `maxDepth` (8), `maxStringLength` (8_192), `maxArrayLength` (200), and a
    per-call `maxNodes, maxContentBytes (16KB serialized-byte budget — the deterministic bytes-per-entry cap)` (5_000) node budget that caps a mega-graph regardless of its
    shape. Defaults are generous — a normal request / query / cache entry is cloned
    byte-identically; bounds only bite on pathological content. Key/path masking,
    cycle-safety, sync-and-never-throwing behavior, and the public `redact()`
    signature are unchanged. A new sibling `redactBounded()` also returns whether
    truncation happened.
  - **Recorder hardening.** `drain()` nulls drained ring slots so flushed fat
    entries aren't retained afterward. A new `truncatedCount` self-metric counts
    entries whose content hit a bound; it surfaces automatically in
    `GET /telescope/api/health`, and the dashboard Overview adds a _Truncated_ stat
    card (ui patch).
  - **High-volume guidance.** When `prune` is set but `sampling` is empty, boot logs
    a one-line INFO pointing at per-type sampling (e.g. `sampling: { cache: 0.1 }`)
    to bound store volume on high-cardinality streams.

- Updated dependencies [[`c2423f3`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c2423f330be3f9b92c0dbf2348220bf8740dab86), [`d8173d4`](https://github.com/DavideCarvalho/nestjs-telescope/commit/d8173d4c5d362814aa0fcdb0bfb35fd353b3d1a8), [`d200d15`](https://github.com/DavideCarvalho/nestjs-telescope/commit/d200d158f927e6a67396e594b32bfd0a0b3424e4), [`953ae12`](https://github.com/DavideCarvalho/nestjs-telescope/commit/953ae12fd35e42df3b806d6bbec6b49e3e3c71fb), [`4ceb884`](https://github.com/DavideCarvalho/nestjs-telescope/commit/4ceb8846b7307cf522d841c909d7eaf7fcb1aa4e), [`15e3e90`](https://github.com/DavideCarvalho/nestjs-telescope/commit/15e3e903d82616966342feeb966fbd44ad6a2631)]:
  - @dudousxd/nestjs-telescope@2.0.0

## 1.0.0

### Minor Changes

- [`1f00e62`](https://github.com/DavideCarvalho/nestjs-telescope/commit/1f00e62c8e60482b64251813680a5f866ef1619a) - Make the telescope mount path configurable. `TelescopeModule.forRoot({ path:
'observability' })` and `TelescopeUiModule.forRoot({ path: 'observability' })`
  now serve the dashboard at `/observability` and the API at `/observability/api`.
  The `path` option (normalized — leading/trailing slashes stripped) defaults to
  `'telescope'`, so behavior is byte-identical when unset.

  Core binds the API controller route at module-build time via a per-`forRoot`
  subclass of `TelescopeController` (`dynamicController(...)`), preserving all
  route/DI metadata. `forRootAsync` accepts a static `path` field (the route must
  be known synchronously). The request-capture middleware now skips the configured
  path instead of a hardcoded `/telescope`, and the resolved core config exposes
  `path`.

  The UI is **not** rebuilt per-path: the SPA keeps the `/telescope/` Vite base
  placeholder and the UI controller rewrites the asset base to `/<path>/` at serve
  time, injecting `window.__TELESCOPE_BASE__` so the client derives its API base
  (`createTelescopeClient` falls back to `/telescope/api` when the global is
  absent; an explicit `baseUrl` still wins). Asset traversal safety is unchanged.

- [`090cd1f`](https://github.com/DavideCarvalho/nestjs-telescope/commit/090cd1ff871dbe46c1c877a26f90496550b5304c) - Dashboard insights, charts, and trace grouping. Core gains a `StatsService` +
  `GET /stats` endpoint with per-type analytics (latency p50/p95/p99, query-family
  breakdown, cache hit/miss ratio, request status breakdown) and an `EntryQuery.traceId`
  filter across all storages. The schedule watcher now tags scheduled runs with a stable
  `schedule` tag. The dashboard adds a per-type insights header with Recharts cards, cache
  hit/miss badges, a working Schedule view (job entries tagged `schedule`), and a
  `#/traces/:traceId` page that groups every entry sharing an OpenTelemetry trace.

- [`b7326b3`](https://github.com/DavideCarvalho/nestjs-telescope/commit/b7326b33d8d55b5f1ac5de4256f5e1980278699e) - Add a **Dumps** dev tool. Call `telescopeDump(value, 'label')` anywhere in your
  code (no dependency injection at the call site) and the value shows up in a new
  "Dumps" tab in the dashboard — a request-correlated alternative to
  `console.log`. `telescopeDump` forwards to a module-level sink that
  `TelescopeService` wires on construction and detaches on shutdown (it is a
  no-op until wired, so importing it in shared code never crashes outside a
  Telescope-enabled app). `TelescopeService.dump(value, label?)` records a `dump`
  entry whose `value` is redacted by the Recorder like any other content and
  correlated to the active batch. Core exports `telescopeDump`, `setTelescopeDump`,
  `DumpContent`, and `EntryType.Dump`. The UI gains a `dump` entry type, a detail
  view that renders the label and pretty-printed JSON value (guarding
  non-serializable values), and a table summary showing the label or a value
  preview.

- [`bfc0e26`](https://github.com/DavideCarvalho/nestjs-telescope/commit/bfc0e268388b5563d05c24e4de6ff99c74d1201a) - Add free-text search over entries. `EntryQuery` gains a `search?: string` field —
  a case-insensitive substring matched against the entry's serialized `content`, so
  you can find a request by uri, a query by sql, a cache op by key, or an exception
  by message. It is applied as an extra AND predicate, so it composes with every
  other filter and with keyset pagination, and it is independent of `omitContent`
  (the match runs over the stored content before any projection).

  Every storage provider implements it: sqlite (`content LIKE '%term%'`), mikro-orm
  (`raw('content')` `$like` so the JSON column is matched as text, not JSON-encoded),
  in-memory and redis (case-insensitive substring over `JSON.stringify(content)` in
  the predicate / in-scan post-filter). The `GET /entries` endpoint reads a non-empty
  `search` query param, and the dashboard entries filter bar gains a "Search content"
  input (commits on Enter/blur, never on keystroke) shown as a clearable
  `search:"term"` chip that "Clear filters" drops.

- [`6817fe6`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6817fe62775b1ff847fdb1038d3298e7709569e0) - Add exception grouping to the per-type stats insight. `summarizeStats` now
  returns `exceptions?: ExceptionGroupStats[]` for the `exception` type: groups
  the window's exception entries by family key (the entry's `familyHash`, or a
  `${class}: ${message}` fallback when null) with `count`, `lastAt`, `class`,
  `message`, and a per-bucket `overTime` series aligned to the report's buckets,
  sorted by count desc then last-seen desc (top 8). The Exceptions view renders an
  "Exception groups" list — class (mono), truncated message, count, relative
  last-seen, and an inline over-time sparkline — each row drilling through to that
  group's occurrences via `?familyHash=`.

- [`20ceb87`](https://github.com/DavideCarvalho/nestjs-telescope/commit/20ceb878cd4495dfbc7a3c71d882ae216a633757) - Surface JSON export and retention/sampling in the dashboard.

  Core: `TelescopeMeta` (`GET /meta`) now reports the resolved `retention`
  (`{ afterMs, keepLast }` from `prune`, or `null` when unbounded) and the
  resolved per-type `sampling` rates, sourced from the resolved config.

  UI: the entry-detail page gains a "Copy JSON" / "Download JSON" toolbar that
  exports the full `EntryWithBatch` (`telescope-entry-<id>.json`); the trace page
  gains a "Download JSON" button exporting all trace entries as a JSON array
  (`telescope-trace-<traceId>.json`). The dashboard header shows a subtle
  retention indicator (e.g. "retention: 5m", or "none" when unbounded) with a
  sampling tooltip when any type is down-sampled below 1. New `toPrettyJson`,
  `copyJson`, and `downloadJson` export utilities back the buttons; clipboard
  absence degrades gracefully.

- [`d3ccf7d`](https://github.com/DavideCarvalho/nestjs-telescope/commit/d3ccf7dfdbe515b7efe134ca0d7d0cfb901bc8a2) - Add a "Telescope health" card to the Overview page rendering `GET /health`:
  per-capture cost (µs), buffer pressure + high-water, flush durations, and dropped
  count (green when keeping up, red with an overflow/store breakdown when shedding).
  Makes Telescope's own overhead visible at a glance.

- [`9d8eb65`](https://github.com/DavideCarvalho/nestjs-telescope/commit/9d8eb6562a7584801d5aa8b74491091f0fade5f9) - Let operators **enqueue (send) a new job/message** onto a queue from the dashboard.

  Core adds an optional `enqueue?(queue, payload, opts, ctx)` method to the
  `QueueManager` SPI and a new `POST /telescope/api/queues/live/:driver/:queue/enqueue`
  route. Unlike the other mutations it carries a JSON body (`{ name?, payload }`),
  so it lives on its own path rather than under `:action` — but it flows through the
  same default-deny `TelescopeActionGuard` as `retry` / `remove` / `redrive`: the
  guard recovers the `enqueue` action from the request path, so without an
  `authorizeAction` callback it returns `403`. The route returns `400` when the
  payload is absent and `404` when the driver is unknown or doesn't implement
  `enqueue`. `enqueue` is added to `QUEUE_ACTIONS` and advertised in the
  `/queues/live` `actionsByDriver` capabilities when a manager implements it.

  `BullMqQueueManager` implements `enqueue` via the real `Queue.add(name, data)`
  (defaulting the name to `manual`), returning the new job id.

  The UI gains an "Send message" form on the queue console — shown only when the
  selected driver advertises `enqueue` and mutations are enabled. It parses the
  payload textarea as JSON (invalid JSON surfaces inline without calling the API),
  posts via a new `queueEnqueue` client method, and on success confirms and
  refreshes the queue counts/jobs. A `403` surfaces inline as "Not authorized".

- [`9b6f12f`](https://github.com/DavideCarvalho/nestjs-telescope/commit/9b6f12f8b00f847f52c1adaa043c1e32d0b64598) - Add the live queue management console. The Queues area now leads with a
  master-detail manager (`#/queues`): a live queue list with per-state count
  badges and paused indicators, state tabs, a dense job table with cursor-based
  "Load more", and a slide-over job detail drawer (pretty-printed payload/opts,
  timestamps, attempts, and stacktrace for failures). Retry / remove / promote
  and "Retry all failed" actions render only when the driver advertises the
  action and `mutationsEnabled` is true (server-side default-deny still enforced;
  403s surface a friendly "Not authorized" hint). The Phase-3 throughput/runtime
  metrics now live under a `Metrics` sub-tab (`#/queues/metrics`) so there is a
  single, coherent "Queues" nav entry.

- [`ba7eeae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/ba7eeaeb23da9d054f5ef40b769f7738607305e6) - Add a gated "Redrive DLQ" action to the queue management UI. On the failed tab /
  queue header, `RedriveDlqButton` is shown only when the driver advertises
  `'redrive'` (`capabilities.actionsByDriver[driver]`) and `mutationsEnabled` is
  true — so it surfaces for SQS-style DLQ drivers and stays hidden for BullMQ. It
  confirms before firing (it moves messages back to the source queue) via the
  existing `useQueueAction()` with `action: 'redrive'`, and a 403 surfaces inline as
  "Not authorized".

- [`3778c8d`](https://github.com/DavideCarvalho/nestjs-telescope/commit/3778c8d9fbbfeb96e0e32b5ebed63751a9debcd7) - Add Laravel-Telescope-style per-type navigation and entry filtering to the
  dashboard UI. The chrome is now a left sidebar with the existing top-level nav
  (Overview, Entries, Pulse, Queues) plus a grouped "Watchers" section linking to
  each entry type (Requests, Queries, Exceptions, Jobs, Mail, Cache, Schedule,
  HTTP Client), each with a per-type color dot and routing to the entries list
  pre-filtered to that type via `#/entries/<type>`. The entries list gains a
  compact filter bar: an active-type chip with a clear affordance, a tag text
  filter wired into the backend-supported `tag` query param, a "Clear filters"
  control, and type/tag-aware empty states. Entry detail moves to
  `#/entries/view/:id` to disambiguate from the per-type list route.

- [`25fcff4`](https://github.com/DavideCarvalho/nestjs-telescope/commit/25fcff41ea9783d8a8085f5a2b7358464d3d74be) - Add a Horizon-style Overview landing page (now the index route `#/`) with a stat
  cards row (entries, requests, exceptions, jobs, jobs/min, failed jobs), a
  throughput area chart, a by-type stacked-area chart, and recent-failures /
  slowest lists linking to entry detail. Introduce dark-themed Recharts chart
  primitives (`AreaChartCard`, `StackedAreaChartCard`, `BarChartCard` + shared
  `chart-theme`), exported from `/react`, with all Recharts imports isolated to
  `src/react/components/charts/*`. Re-skin the Pulse throughput-by-type and the
  Queues failure-rate visualizations onto the new charts.

- [`c0804b9`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c0804b96523deeb92762a03aa6b1ccee16598cef) - Add a global live-tail pause/resume toggle to the dashboard. A `Live`/`Paused`
  control in the header freezes all polling so you can inspect a moment in time.
  `TelescopeProvider` now exposes a live-tail flag via `useLiveTail()`/`usePaused()`,
  and every polling query hook (entries, meta, pulse, stats, queues, timeseries,
  traces, live queues, queue jobs) sets `refetchInterval: false` while paused and
  resumes at the normal interval when live. Default is live (unchanged behavior).
  Manual navigation/clicks still fetch — only the interval is gated.

- [`6fa0946`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6fa0946f5543868704864af2e32793eb448ac827) - Add the `model` and `redis` entry types (`EntryType.Model` / `EntryType.Redis`)
  and their content shapes `ModelContent { action, entity, id, changes }` and
  `RedisContent { command, args, durationMs }`, consumed by the new
  `@dudousxd/nestjs-telescope-mikro-orm-watcher` and
  `@dudousxd/nestjs-telescope-redis-watcher`. The UI gains Models/Redis nav types,
  `ModelBody` / `RedisBody` detail renderers, and table summaries
  (`<action> <entity>#<id>` for model, `<COMMAND> <args-preview>` for redis).

- [`d507547`](https://github.com/DavideCarvalho/nestjs-telescope/commit/d507547df3c13e76e90b8a97c4e3e1d8aef25bd1) - Add OpenTelemetry trace linking. The new `@dudousxd/nestjs-telescope-otel`
  package implements core's `TraceContextProvider` SPI by reading the active
  OpenTelemetry span via `@opentelemetry/api` (`OtelTraceContextProvider`,
  optional peer, read-only — never creates or exports spans, degrades to `null`
  when no span/API is present). Core gains the `TraceContextProvider` SPI,
  `traceId`/`spanId` on each `Entry`, and a `meta.traceLink` template so the UI
  can deep-link entries to a trace backend; the MikroORM storage provider adds the
  corresponding trace columns so the ids survive persistence. The Redis storage
  provider now reconstructs `traceId`/`spanId` when reading entries back, and the
  dashboard shows a Trace row in the entry detail with a clickable deep-link when
  `traceLink` is configured.

- [`cad6dae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/cad6dae0dba4f22e476d78c23ce2f74f7f6848e4) - Two pulse/dashboard UX improvements.

  N+1 query hotspots are now aggregated by query family instead of listed per
  request. `summarizePulse` returns `NPlusOneHotspot[]` — one row per family with
  `perRequest` (worst single-request repetition), `requests` (how many requests
  tripped the threshold), `total` (sum of repetitions), and `sampleBatchId` (the
  worst batch). Identical queries that previously appeared as several identical
  rows now collapse into a single hotspot, sorted by total repetitions. The Pulse
  panel renders `×{perRequest} per request · {requests} requests · {total} total`
  and links each hotspot to its query family (`#/entries/query?familyHash=…`).

  The entries table now surfaces a subtle `trace:<id>` chip on any row that
  belongs to a trace, linking straight to `#/traces/:traceId` so traces are
  discoverable from the list without opening an entry's detail. Rows without a
  trace show nothing extra.

- [`c8596c8`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c8596c85712880cb235e8cce059a1d93d339e9bd) - Add slow-request hotspots to the pulse panel — like the N+1 hotspot, but for
  endpoints: which routes are consistently slow, aggregated by route with `p99`,
  `p50`, and request `count`.

  Request entries now carry a readable, normalized **route family** as their
  `familyHash` (e.g. `"GET /api/base/:id/mel"`), via a new pure
  `normalizeRoute(method, url)` helper that strips the query string and replaces
  id-like path segments (UUID / all-digits / long hex) with `:id`. The route
  family doubles as the human label and indexes on the existing `family_hash`
  column, so the new `slowRoutes` aggregation runs entirely over content-less
  columns in the existing two-pass pulse scan — no `content` reads, no hydration.

  The pulse panel renders a "Slow request hotspots" section; each row links
  through to that route's request entries (`familyHash` filter).

- [`abde392`](https://github.com/DavideCarvalho/nestjs-telescope/commit/abde39264effb31b0524cc4fa89a335276c8dccb) - Capture requests under a global prefix, and make query-shape insights actionable.

  Core: the request-capture middleware no longer relies on NestJS module routing,
  which silently scoped the catch-all to `/` whenever the host called
  `setGlobalPrefix(...)`. New `telescopeRequestCapture(service)` factory lets hosts
  register the capture globally (`app.use(...)` in bootstrap), and a
  `registerRequestMiddleware: false` option disables the built-in registration.
  Telescope's own dashboard routes are skipped inside the middleware instead of via
  `.exclude()` (which breaks with catch-all routes). The query-family label now
  tolerates content shapes that omit `slow`/`connection` (e.g. the MikroORM logger).

  UI: the "Slowest query shapes" chart uses a horizontal, truncated layout (full
  SQL on hover) so long labels no longer overlap, and each bar is clickable —
  drilling into the entries list filtered to that query family.

- [`8ff32a2`](https://github.com/DavideCarvalho/nestjs-telescope/commit/8ff32a2cc95775224eea3377460d91674dfda47f) - Capture richer request detail. The request middleware now records the parsed
  request body as `payload` and the authenticated user as the new
  `RequestContent.user` field — read in the `res.on('finish')` callback (after the
  host body-parser and guards have run). The user defaults to the raw request's
  `user` (the Passport/guard convention) and is customizable via the new
  `TelescopeModuleOptions.resolveUser(request)` hook. Both flow through the
  Recorder's redaction (passwords/tokens masked). The request detail UI gains
  collapsible Headers (with count), a pretty-printed Payload section, and a User
  section ("anonymous" when none).

- [`b14a201`](https://github.com/DavideCarvalho/nestjs-telescope/commit/b14a20175eae3d3017e8cbc068d367a03f634175) - Add a live Schedule console for `@nestjs/schedule` scheduled tasks, mirroring the
  Queues console.

  Core gains a `ScheduleManager` SPI (`ScheduledTask` = name, kind, schedule,
  nextRunAt, lastRunAt, lastDurationMs, lastStatus), a `ScheduleManagerRegistry`
  that boots the configured managers, a `scheduleManagers?` option, and a
  read-guarded `GET /telescope/api/schedules/live` returning `{ tasks }`.

  The `@nestjs/schedule` watcher now also implements `ScheduleManager`: its
  `listTasks()` reads `SchedulerRegistry` (via `moduleRef`) for the registered
  cron/interval/timeout names, cron expression and next fire time, and merges its
  own in-memory last-run map (additive to the existing entry-recording path). It
  degrades gracefully — a missing/partial registry yields a null-filled or empty
  list and never throws.

  The UI adds a read-only `#/schedules` page (a table of name, kind, schedule,
  next run, last run, duration, status) that polls like the queues console and
  honors the live-tail pause, a `schedulesLive()` client method + `useSchedulesLive()`
  hook, and a "Schedules" sidebar console link (distinct from the per-type
  Schedule entries tab).

- [`a90ef56`](https://github.com/DavideCarvalho/nestjs-telescope/commit/a90ef569ba12484bece07d8de2045e13ff2ff528) - Two dashboard additions:

  - **Slow outgoing HTTP hotspots.** The `http_client` watcher now records a
    grouping `familyHash` of `${method} ${host}${normalizedPath}` (via a new
    `normalizeHttpTarget` helper that keeps the host and `:id`-normalizes the
    path), so outbound calls to the same external endpoint aggregate regardless of
    ids. Pulse gains `slowOutgoing: SlowRouteHotspot[]` — top-N external targets by
    p99 (count + p99/p50 over `durationMs`), computed entirely from content-less
    columns (no hydration). The UI renders a "Slow outgoing HTTP" section in the
    Pulse panel, each row deep-linking to `#/entries/http_client?familyHash=…`.

  - **Server stats card.** A read-guarded `GET /telescope/api/server-stats`
    endpoint returns a point-in-time Node process-health snapshot
    (`uptimeSec`, `memory` RSS/heap MB, `cpu` user/system ms, `eventLoopDelayMs`,
    `instanceId`). Event-loop delay is read from a `perf_hooks.monitorEventLoopDelay`
    histogram started once at service init and degrades to `null` when unavailable.
    The UI Overview page shows a polled "Server" card (honors pause) via the new
    `serverStats()` client method and `useServerStats()` hook.

- [`f144584`](https://github.com/DavideCarvalho/nestjs-telescope/commit/f144584f7be7bda2a1189ddfd0b9fd461d2e1e86) - Turn the entries tag filter into an accessible autocomplete. Typing now queries
  `GET /telescope/api/tags?prefix=` and surfaces matching tags with their entry
  counts (top 10, sorted by count desc); picking one applies it as the active tag
  filter and shows a clearable chip. Adds a `tags(prefix?)` client method and a
  `useTags(prefix)` hook (non-polling reference data) plus the `TagCount` type.

- [`7b6636b`](https://github.com/DavideCarvalho/nestjs-telescope/commit/7b6636b54438427cd53ea0cbedd186b77d807169) - Add `@dudousxd/nestjs-telescope-ui`: a bundled React dashboard served by
  `TelescopeUiModule` (no host frontend deps), with an Entries view (type tabs,
  polling) and correlated entry detail. The same building blocks are exported at
  `/react` (components + hooks) and `/client` (typed API client) so consumers can
  compose their own dashboard. Core's request middleware now also excludes the
  `/telescope` UI routes from capture.

- [`e64f35a`](https://github.com/DavideCarvalho/nestjs-telescope/commit/e64f35a1bb7cae15b2ef24404888463d04f81eef) - Add throughput time-series. `GET /telescope/api/timeseries?window=1h&buckets=60`
  returns bucketed entry counts (total + per type) computed from stored entries
  (`TimeseriesService` + `bucketTimeseries`), with optional `type`/`tag` filters.
  The dashboard renders it as a zero-dependency SVG `Sparkline` on the Pulse page
  (also exported at `/react`).

- [`4892ef6`](https://github.com/DavideCarvalho/nestjs-telescope/commit/4892ef61e45e5486d34c7ec82764e6767fe8233d) - Add a **Traces list** — browse recent distinct OTel traces instead of only
  drilling in from a single entry. Core gains a pure `summarizeTraces` that groups
  windowed entries by `traceId` (skipping null trace ids) into per-trace summaries
  (`entryCount`, distinct sorted `types`, `firstAt`/`lastAt`, summed
  `totalDurationMs`, optional `rootLabel`), a `TracesService` that scans the store
  content-less over a window, and a `GET /telescope/api/traces?window=&limit=`
  endpoint (read-guarded, mirrors `/timeseries`). The dashboard adds a **Traces**
  nav item and a `#/traces` page listing recent traces — each row shows the root
  label (or traceId), the type dots present, entry count, total duration, and
  relative time, and links to the existing `#/traces/:traceId` grouping page.

- [`205eabe`](https://github.com/DavideCarvalho/nestjs-telescope/commit/205eabe2c3a34496f2dea608e89887407f4997df) - Add a Cmd+K / Ctrl+K command palette and a light/dark theme toggle to the
  dashboard. The palette is a centered modal (backdrop/Escape close, focus-trapped
  input, ArrowUp/Down wrapping highlight, Enter to navigate via the hash router)
  whose action list is built from `ENTRY_TYPES` plus the static page targets so it
  stays in sync. A header "⌘K" badge also opens it. The theme toggle (dark default)
  persists to `localStorage`, restores on load, and applies a `light`/`dark` root
  class; a scoped `.light` stylesheet flips the most common dark surfaces, text, and
  borders for a usable light mode (full per-component theming is a follow-up).

- [`7797a2a`](https://github.com/DavideCarvalho/nestjs-telescope/commit/7797a2a1554aff49bb59f5ca1b204974a7e04a41) - Render the new `event` and `log` entry types: nav entries (Events/Logs), an event
  detail (name + pretty payload + listener count) and a log detail (level badge +
  message + context), plus table summaries (`event` name / `[level] message`).

- [`8dcded2`](https://github.com/DavideCarvalho/nestjs-telescope/commit/8dcded2a46582799e8176a83136a56cd1ac1f7fb) - Richer dashboard charts: per-type stacked-bar throughput (with a legend) on the
  Pulse page, and a per-queue throughput sparkline column on the Queues page (via
  a `tag`-filtered timeseries). New `StackedBars` / `QueueSparkline` components +
  `stackedBarLayout`/`deriveTypes`/`colorForType` helpers exported at `/react`;
  `QueuesPanel` gains an optional `sparkline` render-prop.

- [`d4c3986`](https://github.com/DavideCarvalho/nestjs-telescope/commit/d4c398631c2a77867b26a4b9bc86db073d9dd8c3) - Complete the dashboard with Pulse (per-type counts, slowest entries, top
  exceptions, N+1 hotspots) and Queues (throughput, failure rate, runtime/wait
  percentiles) views, each with a window selector. Typed the `pulse()`/`queues()`
  client responses and exported `PulsePanel`/`QueuesPanel`/`WindowSelect` at
  `/react`. Added an e2e that serves the real built bundle.

- [`e995e26`](https://github.com/DavideCarvalho/nestjs-telescope/commit/e995e266c87673f865164e76c7c930eb5170f6ac) - Show a request's batch as a compact timeline/waterfall in the entry detail. When
  viewing a `request` entry that captured children (queries, cache, jobs, …), a new
  `RequestTimeline` renders one row per batch entry ordered by `sequence`: a type
  dot, a short label, a horizontal duration bar scaled to the slowest entry in the
  batch, and the `durationMs`. Each row links to that child's detail. This makes
  "where did the time go in this request" obvious without leaving for a trace
  viewer. Null-duration children render with a minimal bar, and large batches cap
  at 50 rows with a "+N more" note.

### Patch Changes

- [`da0aa24`](https://github.com/DavideCarvalho/nestjs-telescope/commit/da0aa245b4efac6b95037339b0b81b50305bf9d9) - Serve the dashboard `index.html` with `Cache-Control: no-store` and the hashed
  asset bundles with a long immutable cache. Previously index.html had no cache
  headers, so browsers kept loading a stale bundle across upgrades — the classic
  "a widget is stuck loading / shows old labels after deploying a new version".
- Updated dependencies [[`73b50ad`](https://github.com/DavideCarvalho/nestjs-telescope/commit/73b50ad00193127271fdec36ad080d2858045922), [`9126bb0`](https://github.com/DavideCarvalho/nestjs-telescope/commit/9126bb04777cdaec6af3b0a1c5fe6f91d055ce82), [`1f00e62`](https://github.com/DavideCarvalho/nestjs-telescope/commit/1f00e62c8e60482b64251813680a5f866ef1619a), [`090cd1f`](https://github.com/DavideCarvalho/nestjs-telescope/commit/090cd1ff871dbe46c1c877a26f90496550b5304c), [`b7326b3`](https://github.com/DavideCarvalho/nestjs-telescope/commit/b7326b33d8d55b5f1ac5de4256f5e1980278699e), [`bfc0e26`](https://github.com/DavideCarvalho/nestjs-telescope/commit/bfc0e268388b5563d05c24e4de6ff99c74d1201a), [`7797a2a`](https://github.com/DavideCarvalho/nestjs-telescope/commit/7797a2a1554aff49bb59f5ca1b204974a7e04a41), [`6817fe6`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6817fe62775b1ff847fdb1038d3298e7709569e0), [`20ceb87`](https://github.com/DavideCarvalho/nestjs-telescope/commit/20ceb878cd4495dfbc7a3c71d882ae216a633757), [`1dd4db0`](https://github.com/DavideCarvalho/nestjs-telescope/commit/1dd4db0f3cd46d04b35ac112343cfb424c2d3190), [`a9f517c`](https://github.com/DavideCarvalho/nestjs-telescope/commit/a9f517c076461aef55cfb90d072ec38427ace91b), [`9d8eb65`](https://github.com/DavideCarvalho/nestjs-telescope/commit/9d8eb6562a7584801d5aa8b74491091f0fade5f9), [`418f1f0`](https://github.com/DavideCarvalho/nestjs-telescope/commit/418f1f0421948b40b25f845441a716fa4c6655c2), [`e76980d`](https://github.com/DavideCarvalho/nestjs-telescope/commit/e76980ddd7ee740f1b337a422a98ca98d97a007e), [`80c8f97`](https://github.com/DavideCarvalho/nestjs-telescope/commit/80c8f9769c8ab9ee724635086740910bc4d44ea3), [`e14ac60`](https://github.com/DavideCarvalho/nestjs-telescope/commit/e14ac603551372fc3767c63a349c509582b5e6ab), [`6fa0946`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6fa0946f5543868704864af2e32793eb448ac827), [`d507547`](https://github.com/DavideCarvalho/nestjs-telescope/commit/d507547df3c13e76e90b8a97c4e3e1d8aef25bd1), [`affd07e`](https://github.com/DavideCarvalho/nestjs-telescope/commit/affd07e4cb9ee85cfabaabed424833e8c638d04a), [`6a4d8d5`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6a4d8d56321d3840fe64e646130ccfdafcfb1bdd), [`c1f1ec9`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c1f1ec903d470d6b884924e2713de305b61b7481), [`cad6dae`](https://github.com/DavideCarvalho/nestjs-telescope/commit/cad6dae0dba4f22e476d78c23ce2f74f7f6848e4), [`c8596c8`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c8596c85712880cb235e8cce059a1d93d339e9bd), [`c4222b1`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c4222b16ef4c0fc9c61694eb67033f03369ff24e), [`de29d2f`](https://github.com/DavideCarvalho/nestjs-telescope/commit/de29d2f519b1f25bc702c9dcc737d99b4751c8c9), [`10a3bc2`](https://github.com/DavideCarvalho/nestjs-telescope/commit/10a3bc224f6e0b1a237e1e7631acad70493b4c12), [`abde392`](https://github.com/DavideCarvalho/nestjs-telescope/commit/abde39264effb31b0524cc4fa89a335276c8dccb), [`8ff32a2`](https://github.com/DavideCarvalho/nestjs-telescope/commit/8ff32a2cc95775224eea3377460d91674dfda47f), [`5f2eddd`](https://github.com/DavideCarvalho/nestjs-telescope/commit/5f2eddd0ed5d72bf1de323b45870d7ddcaf64349), [`b14a201`](https://github.com/DavideCarvalho/nestjs-telescope/commit/b14a20175eae3d3017e8cbc068d367a03f634175), [`a90ef56`](https://github.com/DavideCarvalho/nestjs-telescope/commit/a90ef569ba12484bece07d8de2045e13ff2ff528), [`593bcc8`](https://github.com/DavideCarvalho/nestjs-telescope/commit/593bcc85ad6558040c62ba66bd1e5e0cbe5a6ac7), [`7b6636b`](https://github.com/DavideCarvalho/nestjs-telescope/commit/7b6636b54438427cd53ea0cbedd186b77d807169), [`e64f35a`](https://github.com/DavideCarvalho/nestjs-telescope/commit/e64f35a1bb7cae15b2ef24404888463d04f81eef), [`4892ef6`](https://github.com/DavideCarvalho/nestjs-telescope/commit/4892ef61e45e5486d34c7ec82764e6767fe8233d)]:
  - @dudousxd/nestjs-telescope@1.0.0
