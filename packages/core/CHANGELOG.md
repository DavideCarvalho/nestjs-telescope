# @dudousxd/nestjs-telescope

## 1.10.0

### Minor Changes

- [#15](https://github.com/DavideCarvalho/nestjs-telescope/pull/15) [`64ada5e`](https://github.com/DavideCarvalho/nestjs-telescope/commit/64ada5e485cdf31bdc3e72da354fc0cec8fd8781) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Rich extension dashboards: the panel IR gains delta/sparkline/threshold on `stat`
  and new `distribution`, `gauge`, and `breakdown` panel kinds, plus a `sections`
  layout. Dashboards update in realtime over a new `@Sse` invalidation stream
  (falling back to polling), with a LIVE indicator. Fully backward compatible —
  existing extensions and flat `stat` panels render unchanged.

## 1.9.1

### Patch Changes

- [`f290c02`](https://github.com/DavideCarvalho/nestjs-telescope/commit/f290c02fcc840b2c4c004346f50d1188301465b5) - perf: lighten the per-entry recorder path — compile the redaction key/path Sets once instead of rebuilding them per recorded entry, mutate tags in place in `enrich()` (dropping a full `Entry` clone), and honor the previously-dead `flushBatchSize` by chunking flushes.

## 1.9.0

### Minor Changes

- [#10](https://github.com/DavideCarvalho/nestjs-telescope/pull/10) [`289d82b`](https://github.com/DavideCarvalho/nestjs-telescope/commit/289d82b9f4ec93c65dca72b25f7500872fb926b6) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Soft-detected `@dudousxd/nestjs-context` enrichment for recorded entries (additive, opt-in, no hard dependency).

  When the app imports `@dudousxd/nestjs-context`, Telescope detects its accessor via the shared `CONTEXT_ACCESSOR` symbol (`@Optional() @Inject`) and enriches each recorded entry as a SECONDARY correlation source:

  - **traceId** is taken from `accessor.traceId()` only as a FALLBACK when the OTel `traceContext` provider did not yield one — OTel always wins, so an existing OTel trace id is never clobbered. This lets entries correlate cross-lib (durable/notifications) with the shared context trace id when OTel is absent.
  - **user/tenant tags** (`user:<Type>#<id>`, `tenant:<id>`) are appended so the dashboard can group/filter by the current user and tenant.

  The accessor is read defensively once per entry and can never throw into `record()`. With no accessor bound, behavior is exactly as before.

## 1.8.0

### Minor Changes

- [`b8b1c35`](https://github.com/DavideCarvalho/nestjs-telescope/commit/b8b1c3505c8d6e5487353b449f119c5d6e5fbd55) - Add a `TelescopeExtension` SPI so libraries can contribute to the dashboard. Register extensions via `TelescopeModule.forRoot({ extensions: [...] })`; each may contribute watchers, navigable entry types, declarative dashboard pages (a neutral panel IR — `stat`/`timeseries`/`topN`/`table` — rendered natively by the UI, no extension React), and named server-side data providers served behind the existing read gate at `GET <path>/api/ext/:ext/data/:provider`. Entry types and dashboards surface dynamically in the nav via `/api/meta`. Authoring uses `defineTelescopeExtension(...)`; duplicate entry-type ids, dashboard ids, or provider names across extensions fail fast at boot. See the new "Extensions" concept page and the "Building an extension" recipe.

## 1.7.1

## 1.7.0

### Minor Changes

- [`b35cc6b`](https://github.com/DavideCarvalho/nestjs-telescope/commit/b35cc6b1508e98f75f2ed78b8d08b93569f47089) - Add `@dudousxd/nestjs-telescope-inertia-watcher`: an `InertiaWatcher` that
  subscribes to the `nestjs-inertia:render` diagnostics channel and records one
  `inertia` entry per Inertia render (component, resolved props, deferred/merge
  classification, partial-reload decision, asset version + 409 version-mismatch,
  history flags, page size), correlated to the request batch. Adds the
  `EntryType.Inertia` constant to core. Fully decoupled from `nestjs-inertia` —
  the channel name and payload shape (`v: 1`) are the only contract; malformed or
  wrong-version messages are dropped.

## 1.6.0

### Minor Changes

- MCP server (`<path>/api/mcp`, stateless streamable-HTTP JSON-RPC) so coding agents can query captured entries; request replay endpoint (`GET entries/:id/replay`, gated by authorizeAction); overload protection (auto pause/resume of the Recorder by event-loop lag, default 200ms).

## 1.5.0

### Minor Changes

- [`79e7063`](https://github.com/DavideCarvalho/nestjs-telescope/commit/79e706380c915ee14eb1e1257c6428887889a3b3) - Skip expected 4xx `HttpException`s by default — they're control flow, not incidents.

  The server exception interceptor no longer records a NestJS `HttpException` whose status is a 4xx (`>= 400 && < 500`) as an `exception` entry. A `403 ForbiddenException`, a `404 NotFoundException`, or a `400` from the validation pipe is the framework doing its job — permission denied, resource missing, bad input — not an incident.

  **Why this changed (a real incident):** Telescope's own client-errors `authorize` gate threw a 403, the interceptor captured it as a brand-**new** exception family (the family hash keys on class + message + top frame, so each call site is distinct), which fired the `new-exception` Slack alert and, in AI auto-mode, burned a model diagnosis on intended behaviour. In production every permission denial would page on-call and spend tokens.

  **Nothing is lost.** The request watcher still records the 4xx `statusCode` on its own `request` entry (independently), so the 4xx is still visible in the dashboard and in error-rate metrics — it just no longer opens an exception family, fires `new-exception`, or triggers AI diagnosis. Because the `new-exception` alert and AI auto-diagnosis both consume `exception` entries off the flush path, filtering at capture covers them with no separate change.

  **Always recorded:** 5xx `HttpException`s (real server errors) and any non-`HttpException` error. **Untouched:** browser-reported `client_exception` entries (recorded directly by the ingestion endpoint, never through this interceptor).

  **Escape hatch:** set `exceptions: { captureHttp4xx: true }` (new option, default `false`) to restore the pre-change behaviour and capture 4xx `HttpException`s as exceptions again.

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

- [`8f74c00`](https://github.com/DavideCarvalho/nestjs-telescope/commit/8f74c00f25a57215a68b724ff59cb85c40eaf2db) - Pluggable alert channels + a `new-exception` rule.

  Alerting now fans each fired alert out to one or more **channels** instead of a single webhook:

  - `slackChannel(url, options?)` — Slack Block Kit message (severity header, fielded context, truncated stack, and an "Open in Telescope" deep-link button when `alerts.dashboardUrl` is set)
  - `webhookChannel(url)` — raw JSON POST (the v1 behavior, unchanged)
  - `customChannel(fn, name?)` — your own async sink (email, SNS, PagerDuty, …)

  Channels fan out concurrently; one channel failing never blocks the others, and failures are warn-logged (rate-limited per channel) and never thrown into the host.

  A new `{ type: 'new-exception', window }` rule fires the first time an exception's error family is seen within `window`. It evaluates per-flush (so a brand-new error pages quickly) and carries rich context pulled from the exception entry and its sibling request entry in the same batch (class, message, stack, route/method/status/duration, user, occurrence count, entry + batch ids). Dedup is a bounded per-replica in-memory map (same family may alert once per pod).

  Backward compatible: the legacy `alerts.webhookUrl` is still accepted (folded into a `webhookChannel`), and the raw-webhook payload only gained additive optional fields.

- [`bc3a0df`](https://github.com/DavideCarvalho/nestjs-telescope/commit/bc3a0df784f31a82753725d9c5e86d75380fee13) - Client error ingestion — Telescope as the frontend error reporter.

  A new **public** endpoint, `POST <telescope>/api/client-errors`, lets browsers report errors directly to Telescope instead of a hand-rolled reporter. Reports are recorded as `client_exception` entries through the normal pipeline, so they compose with everything: the `new-exception` alert, per-type prune/archive, and the dashboard.

  - **Opt-in & ungated.** Configure via `clientErrors: { enabled, maxBodyBytes?, rateLimit?, authorize? }`. Disabled by default (a public surface is opt-in) — while off the endpoint returns 404. It carries no dashboard guard (ordinary users' browsers hit it).
  - **Untrusted-body validation.** Dependency-free structural validation: `message` required, every other field optional with type checks + length caps (message ≤ 2 KB, stack/componentStack ≤ 16 KB, url/userAgent ≤ 2 KB). Invalid → 400 with no echo of the payload. Over the byte cap → 413.
  - **Per-IP rate limit.** A bounded in-memory token bucket (default 60/min, ~10k IPs with oldest-IP eviction). Over the limit → 429. Per-pod best-effort (the effective limit is `perMinute × pods` in a multi-replica deployment).
  - **`authorize` hook.** Runs first; `false` → 403 (a throw is a fail-closed denial). Lets hosts validate a session cookie/header.
  - **Composes.** Records `type: client_exception` with a family hash from name + message + top stack frame (the server exception interceptor now uses the same scheme, so both sources group identically), the `failed` / `client` / `user:<id>` tags, and the captured client IP. The `new-exception` rule now fires for `client_exception` too, using the browser URL and user-agent in place of a server route.
  - **Dashboard.** A new watcher-driven **Client errors** tab (shown only when `clientErrors` is enabled) with a detail view rendering message, stack, component stack, URL, and user-agent.

  See the new recipe: _Reporting frontend errors_.

- [`3f72bc5`](https://github.com/DavideCarvalho/nestjs-telescope/commit/3f72bc55cf3a96fe6ea85b37a809b59531caa39a) - Per-type prune retention and an archive sink that exports entries before they are pruned.

  - `prune.perType` overrides the global `after` cutoff for specific entry types (e.g. `{ after: '5m', perType: { exception: '7d' } }`). Types without an override keep using the global cutoff, so omitting `perType` is exactly backward compatible. Per-type durations are validated at module init like `after`.
  - `archive` hands a type's doomed entries to a host-owned `sink` (S3, a data lake, cold storage) **before** the pruner deletes them, in bounded batches. A failing sink keeps the entries (retried next cycle) and never crashes the host or stops the pruner.
  - New optional `StorageProvider.pruneScoped(input)` method backs per-type deletes; it is implemented for every in-repo adapter (SQLite, MikroORM, Redis, in-memory). Third-party providers without it fall back to the global cutoff with a one-time warning.

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

### Patch Changes

- [`1f7f206`](https://github.com/DavideCarvalho/nestjs-telescope/commit/1f7f2062c191d76bb4b7c631f0164f4fd0b90649) - Fix `AxiosInterceptorLike` so a real `AxiosInstance` (including `@nestjs/axios`'s `HttpService.axiosRef`) is assignable without casts. The fulfilled interceptor callbacks are now generic identity signatures (`<C extends AxiosRequestConfigLike>(config: C) => C`) instead of returning the structural type, which axios's own `use` rejected (it requires its concrete `InternalAxiosRequestConfig` back). A compile-time regression test against the real axios types guards this.

## 1.2.0

### Minor Changes

- [`5de71fa`](https://github.com/DavideCarvalho/nestjs-telescope/commit/5de71fa930ba1e7efaf1db947d5ef2d728d1a4e1) - `HttpClientWatcher` can now capture outbound axios / `@nestjs/axios` calls, not just the global `fetch`. In Node axios uses the http adapter (not `fetch`), so `HttpService` traffic was previously invisible. Pass an `axios` source to the watcher to capture it via axios's public interceptor API — no monkey-patching: either a bare axios instance (`new HttpClientWatcher({ axios: client })`) or a custom source (`{ instrument(attach, ctx) }`) that resolves `HttpService` from `ctx.moduleRef` and hands over `axiosRef` lazily at register time. Axios entries share the same content shape, tags, and family-hash as fetch entries, so the two are indistinguishable downstream. Request timing is tracked with a `WeakMap` keyed by the axios config object (no mutation of host objects); rejections record `error.response?.status ?? null` and are always re-thrown; instrumentation is idempotent per axios instance.

- [`6ef3cb0`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6ef3cb02c27002571b357c7f0f4dcacad8918933) - LogsWatcher now auto-patches the `@nestjs/common` `Logger` facade by default, so logs are captured with zero host changes — every `new Logger(Ctx)` instance log and `Logger.log(...)` static is recorded, the original is still invoked, and the patch is idempotent process-wide. Instance and static calls are independent paths in Nest 11 (an instance log delegates to a per-logger `ConsoleLogger`, a static log to `Logger.staticInstanceRef`), so both the `Logger.prototype` methods and the static `Logger.*` methods are teed under sibling `Symbol.for` markers; each logical call records exactly once. The explicit `TelescopeConsoleLogger` path remains for hosts that bypass the facade; both coexist without double-recording thanks to a shared re-entrancy guard (opt out with `new LogsWatcher({ autoPatch: false })`). Core's tail-sampling `keepErrors` is now level-aware: `warn` / `error` / `fatal` log entries count as errors, so `sampling: { log: { rate: 0.1, keepErrors: true } }` samples logs hard while never dropping warnings or errors.

## 1.1.0

### Minor Changes

- [`c2423f3`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c2423f330be3f9b92c0dbf2348220bf8740dab86) - Add webhook alerting (v1).

  A new `alerts` option evaluates rules on an unref'd interval and POSTs a JSON
  payload to a `webhookUrl` when a rule fires (per-rule `cooldown` suppresses
  re-notifies). Three rule kinds: `exception-rate` (`>= threshold` exceptions in a
  `window`), `slow-request-rate` (`>= count` requests slower than `thresholdMs` in
  a `window`), and `dropped-entries` (Recorder `droppedCount` grew by `>= threshold`
  since the last evaluation — a delta). Exception/slow rules read a small,
  content-omitted, scan-capped window via `collectEntriesInWindow`; dropped uses
  the Recorder self-metrics delta.

  The webhook POST is bounded by a 5s `AbortController` timeout; failures are
  warn-logged once per rule kind and **never** throw into the host. A configured
  `alerts` with an empty `webhookUrl` or empty `rules` (or an unparseable duration)
  is a fail-closed boot error. `TelescopeMeta` gains `alerts: { enabled, ruleCount }`.

- [`d8173d4`](https://github.com/DavideCarvalho/nestjs-telescope/commit/d8173d4c5d362814aa0fcdb0bfb35fd353b3d1a8) - Add `dashboardAuth` — a cookie-session gate for the Telescope dashboard.

  Hosts can now require a signed, same-origin session cookie for every dashboard
  API call, all the way to prod, with no infra (no oauth2-proxy/ingress). A
  generic SPA can't send a host's Bearer header on navigations, but a path-scoped
  cookie rides along automatically — so this gates the dashboard without breaking
  its client.

  Two modes mint the same stateless HMAC-SHA256 cookie (`node:crypto` only, no JWT
  dependency):

  - **`session`** (seamless): the host frontend POSTs `/<path>/api/auth/session`
    carrying its own auth; a host hook validates the raw request and returns the
    session user.
  - **`login`** (universal): a built-in login form POSTs `/<path>/api/auth/login`;
    a host hook validates the credentials.

  ```ts
  TelescopeModule.forRoot({
    dashboardAuth: {
      secret: process.env.TELESCOPE_AUTH_SECRET,
      ttl: "8h", // sliding renewal past 50% of the TTL
      login: (u, p) =>
        u === env.USER && p === env.PASS ? { id: "ops" } : null,
    },
  });
  ```

  When configured, `TelescopeGuard` requires a valid cookie on every `/api/*`
  route except `/api/auth/*`, attaches the session as `request.telescopeSession`
  (readable by `authorizer` / `authorizeAction`), and still ANDs the existing
  `authorizer`. `meta` gains `auth: { enabled, modes }`. A missing/empty `secret`
  or no hook is a boot error (fail closed). When unset, behavior is unchanged.

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

- [`953ae12`](https://github.com/DavideCarvalho/nestjs-telescope/commit/953ae12fd35e42df3b806d6bbec6b49e3e3c71fb) - Two Recorder robustness features: a bounded flush retry and tail-sampling.

  - **Bounded flush retry.** A failed `storage.store(batch)` previously dropped the
    whole batch immediately. The Recorder now retries the batch **exactly once**
    after a bounded backoff (`recorder.retryDelayMs`, default `1000`ms); only a
    second failure drops it (the `storeFailedDropped` semantics are unchanged). The
    retry runs _inside_ the single in-flight flush promise, so failed batches never
    pile up and the ring keeps absorbing/evicting meanwhile — memory stays bounded.
    The backoff timer is unref'd (never keeps the event loop alive), and a new
    `delay` seam keeps it deterministic in tests. A new `retriedFlushes`
    self-metric counts batches that needed the retry (surfaced via
    `getSelfMetrics()` / `GET /telescope/api/health`).

  - **Tail-sampling.** `sampling` per-type values may now be a rule object —
    `{ rate, keepErrors?, keepSlowMs? }` — in addition to a bare keep-rate. The
    rule keeps `rate` of the noise but **always** retains errors (`keepErrors`: a
    `failed` tag, `content.failed === true`, or `content.statusCode >= 500`) and
    slow entries (`durationMs >= keepSlowMs`). Plain-number config keeps its exact
    prior behaviour. The decision uses only shallow fields already on the
    `RecordInput` (type, tags, durationMs, a couple of content property reads), so
    the hot path stays cheap. Resolution/normalization lives in `resolveConfig`.

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

## 1.0.0

### Minor Changes

- [`73b50ad`](https://github.com/DavideCarvalho/nestjs-telescope/commit/73b50ad00193127271fdec36ad080d2858045922) - Add the BullMQ job watcher (`@dudousxd/nestjs-telescope-bullmq`). It discovers
  `@nestjs/bullmq` `WorkerHost` processors and wraps each job in a `'queue'` batch,
  capturing job outcome/duration/attempts and correlating the queries and
  exceptions a job emits to that job. Core now imports `DiscoveryModule` so
  discovery-based watchers can resolve `DiscoveryService`, and the canonical
  `JobContent` gains `id` and `maxAttempts`.

- [`9126bb0`](https://github.com/DavideCarvalho/nestjs-telescope/commit/9126bb04777cdaec6af3b0a1c5fe6f91d055ce82) - Add the cache watcher (`@dudousxd/nestjs-telescope-cache`). `CacheWatcher` wraps
  a `cache-manager` `Cache`'s `get`/`set` (structural type — no hard dependency) to
  capture hits/misses, correlated to the active request/job batch via the caller's
  async context. `get` records `hit` (value present vs `undefined`/`null`) and
  returns the value unchanged; `set` records `hit: null`. Core gains the `cache`
  entry type (`EntryType.Cache`) and `CacheContent` (additive). Recording is
  non-throwing and host errors are always re-thrown.

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

- [`7797a2a`](https://github.com/DavideCarvalho/nestjs-telescope/commit/7797a2a1554aff49bb59f5ca1b204974a7e04a41) - Add the `event` and `log` entry types (`EntryType.Event` / `EntryType.Log`) and
  their content shapes `EventContent { name, payload, listenerCount }` and
  `LogContent { level, message, context }`, consumed by the new
  `@dudousxd/nestjs-telescope-events` and `@dudousxd/nestjs-telescope-logs` watchers.

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

- [`1dd4db0`](https://github.com/DavideCarvalho/nestjs-telescope/commit/1dd4db0f3cd46d04b35ac112343cfb424c2d3190) - Estimate latency percentiles (p50/p95/p99 in `/stats`) from a pre-aggregated
  latency histogram instead of scanning every raw entry in the window. Rollups now
  carry a fixed-size `histogram` (counts per `LATENCY_BOUNDARIES_MS` cell, plus an
  overflow cell) aggregated at flush time from `durationMs`. When the store is a
  `RollupStore`, `StatsService` queries the histogram rollups for the type+window,
  merges them element-wise, and calls `estimatePercentileFromHistogram`
  (bucket-resolution nearest-rank, O(buckets)); count/max/slow and the
  family/cache/status/exception breakdowns still derive from the raw scan, and
  stores without rollup support keep the exact raw-scan percentile path as a
  fallback.

  The histogram is persisted and merged additively by every `RollupStore`
  implementation (in-memory, core SQLite, MikroORM, Redis). Legacy rollup
  rows/hashes without a histogram are self-healed (new column/field) and read back
  as an all-zeros array of the canonical length — never NaN, never a crash.

- [`a9f517c`](https://github.com/DavideCarvalho/nestjs-telescope/commit/a9f517c076461aef55cfb90d072ec38427ace91b) - Add gated queue **mutation** endpoints on top of the live-queue reads. The core
  controller now exposes `POST /telescope/api/queues/live/:driver/:queue/jobs/:id/:action`
  (`retry` / `remove` / `promote`) and `POST .../actions/:action` (`retry-all`,
  `redrive`), each carrying `:action` so a single `TelescopeActionGuard` authorizes
  them uniformly.

  Mutations are **default-deny**: they run behind a new `authorizeAction` option
  _in addition to_ the read `authorizer`, and the guard fails closed. Without an
  `authorizeAction` callback every mutation returns `403` — even for callers the
  read authorizer already trusts. `authorizeAction(ctx, { driver, queue, action,
jobId?, state? })` opts in; returning falsy or throwing denies.

  `BullMqQueueManager` implements `retry` / `remove` / `promote` / `retryAll`
  against the real BullMQ `Job.retry()` / `Job.remove()` / `Job.promote()` and
  `Queue.retryJobs()` APIs (`retryAll` returns the pre-action count for the state).
  `redrive` remains SQS-only and returns `405` on the bullmq driver.

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

- [`418f1f0`](https://github.com/DavideCarvalho/nestjs-telescope/commit/418f1f0421948b40b25f845441a716fa4c6655c2) - Add a driver-agnostic live-queue read layer. Core gains the `QueueManager` SPI
  (`QueueManager`, `QueueManagerContext`, `QueueManagerRegistry`) and its DTO types
  (`QueueState`, `QueueCounts`, `QueueSummary`, `QueueJob`, `QueueJobDetail`,
  `JobPage`), wired through a `queueManagers` option on `TelescopeModule.forRoot`
  and surfaced as read endpoints under the existing authorizer:
  `GET /telescope/api/queues/live`, `…/live/:driver/:queue/counts`,
  `…/live/:driver/:queue/jobs?state=`, and `…/live/:driver/:queue/jobs/:id`.

  `@dudousxd/nestjs-telescope-bullmq` adds `BullMqQueueManager`, which discovers
  `@nestjs/bullmq` `Queue` instances via `DiscoveryService` (duck-typed, optional
  explicit allow-list) and reads them through the BullMQ `Queue` API to report
  live counts, the jobs in each list, and per-job detail. Job payloads are passed
  through core redaction before leaving the server. Reads only this phase — queue
  actions (retry/remove/promote/redrive) land in Phase 2.

- [`e76980d`](https://github.com/DavideCarvalho/nestjs-telescope/commit/e76980ddd7ee740f1b337a422a98ca98d97a007e) - Add `HttpClientWatcher`, a built-in watcher that instruments the global `fetch`
  to capture outbound HTTP calls (method, URL, host, status, duration) correlated
  to the request/job that made them. No peer dependency — it uses Node's built-in
  `fetch`. Captured URLs have credentials and sensitive query params redacted. Adds
  the `http_client` entry type and `HttpClientContent`.

- [`e14ac60`](https://github.com/DavideCarvalho/nestjs-telescope/commit/e14ac603551372fc3767c63a349c509582b5e6ab) - Add `MikroOrmStorageProvider`: persist Telescope entries to MySQL/SQLite through
  MikroORM with zero migration and zero manual table setup.

  The provider owns a **dedicated MikroORM scoped to a single `TelescopeEntry`** and
  **self-heals its schema at boot** (`schema.ensureDatabase()` +
  `schema.update({ safe: true })` — additive only: creates the table and adds
  missing columns, never drops). The scoped connection means the schema diff is
  structurally incapable of touching the host's other tables, and it avoids a
  self-capture loop with the query watcher's `loggerFactory`. Pass your existing
  `MikroORM` (its connection config is borrowed) or explicit connection options to
  run Telescope on a separate database. `ensureSchema: false` opts out.

  Core gains an optional `StorageProvider.init()` boot hook (awaited by
  `TelescopeModule` at startup) and now always calls `close()` after the final
  flush at shutdown — providers that borrow a host-owned resource must no-op
  `close()`. Features newest-first keyset pagination via an `$or` `(createdAt, id)`
  position and cross-driver tag filtering against a space-padded `tagsText` column.

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

- [`affd07e`](https://github.com/DavideCarvalho/nestjs-telescope/commit/affd07e4cb9ee85cfabaabed424833e8c638d04a) - Warn at boot when no `prune` is configured. Without a retention window the entry
  table grows unbounded and the windowed analytics scans (pulse/timeseries/stats)
  slow down over time; the warning points hosts at `prune` (and `sampling` for
  noisy request volume) before they hit it in production.

- [`6a4d8d5`](https://github.com/DavideCarvalho/nestjs-telescope/commit/6a4d8d56321d3840fe64e646130ccfdafcfb1bdd) - Batch pulse two-pass hydration into ONE query. `EntryQuery` gains an optional
  `ids?: string[]` filter: when set, only entries whose `id` is in the set are
  returned (ANDed with every other filter; an empty array returns no rows). Each
  storage applies it natively — SQLite via `id IN (...)`, MikroORM via
  `id: { $in }`, in-memory via a membership `Set`, and Redis via a single `MGET`
  of the entry keys (the big win — it skips the index scan entirely). The pulse
  service now hydrates the displayed rows (top-N slowest + exception reps + N+1
  reps) with one batched `get({ ids })` instead of N per-id `find()` round-trips,
  cutting pulse latency against a remote store. Pulse output shape is unchanged.

- [`c1f1ec9`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c1f1ec903d470d6b884924e2713de305b61b7481) - Add a pulse health endpoint. `GET /telescope/api/pulse?window=1h` returns a
  health snapshot aggregated from captured entries: per-type counts, slowest
  entries (by duration), top exceptions (grouped by family), and per-batch N+1
  query occurrences (`PulseService` + `summarizePulse`). The windowed-read loop is
  extracted into a shared `collectEntriesInWindow` used by both pulse and queue
  metrics.

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

- [`c4222b1`](https://github.com/DavideCarvalho/nestjs-telescope/commit/c4222b16ef4c0fc9c61694eb67033f03369ff24e) - Speed up the `/pulse` and `/timeseries` analytics endpoints by aggregating over
  a content-less projection instead of reading every entry's heavy `content` JSON
  blob.

  `EntryQuery` gains an `omitContent?: boolean` flag. When set, `get()` returns
  entries with `content: null` and the provider skips reading/parsing the content
  column where its driver allows:

  - **mikro-orm**: projects every persisted column EXCEPT `content` via MikroORM's
    `fields` option, so the blob never leaves the database (the main win on MySQL).
  - **sqlite**: SELECTs the content-less column list and skips JSON parsing.
  - **in-memory**: returns shallow copies with `content` nulled.
  - **redis**: stores the whole entry as one blob, so it must read it anyway —
    `omitContent` nulls `content` after parse (correct, but no projection benefit).

  `timeseries` now scans content-less (bucketing only needs `createdAt`/`type`).
  `pulse` runs two passes: pass 1 aggregates the whole window content-less
  (counts, slowest candidates, exception families, N+1 hotspots); pass 2 hydrates
  `content` for ONLY the few displayed rows (top-N slowest, one representative per
  reported exception family, one per reported N+1 family) via targeted `find`s.
  The pulse output shape is unchanged.

  At ~10k entries with large content blobs this drops pulse and timeseries from
  several seconds to a fraction of a second.

- [`de29d2f`](https://github.com/DavideCarvalho/nestjs-telescope/commit/de29d2f519b1f25bc702c9dcc737d99b4751c8c9) - Add Horizon-style queue metrics. A new `GET /telescope/api/queues?window=1h`
  endpoint aggregates captured `job` entries into per-queue throughput, runtime
  and wait-time percentiles, and failure rate (`QueueMetricsService` +
  `aggregateQueueMetrics`). The BullMQ watcher now captures `waitMs`
  (`processedOn − enqueue`) on each job, and the canonical `JobContent` gains a
  `waitMs` field. `durationToMs` is extracted as a shared, exported util.

- [`10a3bc2`](https://github.com/DavideCarvalho/nestjs-telescope/commit/10a3bc224f6e0b1a237e1e7631acad70493b4c12) - Add Recorder self-metrics + `GET /telescope/api/health`: surface Telescope's own
  overhead — buffered count, ring high-water, flush count/durations, drop buckets,
  and an on-demand `captureCostNanos` micro-benchmark of the synchronous capture
  path. Hot-path-safe: `record()` only does integer counter bumps; the per-capture
  cost figure comes from a separate benchmark, never from timing live records.

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

- [`5f2eddd`](https://github.com/DavideCarvalho/nestjs-telescope/commit/5f2eddd0ed5d72bf1de323b45870d7ddcaf64349) - Add a pre-aggregated rollup layer (Pulse-style ingest aggregation) and back the
  timeseries endpoint with it. A new optional `RollupStore` SPI
  (`recordRollups`/`queryRollups`, detected via `isRollupStore`) sits ALONGSIDE
  `StorageProvider` — stores that do not implement it keep working unchanged via
  the raw entry scan. On every successful flush the `Recorder` folds the drained
  batch into 1-minute `(type, bucketStart)` rollups (count/sum/max, null durations
  as 0) and records them best-effort; a rollup failure never affects the entry
  store. `InMemoryStorageProvider` and `SqliteStorageProvider` implement the SPI
  (sqlite via an additive `on conflict do update` upsert into `telescope_rollups`).
  `TimeseriesService` reads rollups when available — re-bucketing the 1-minute
  rollups into the requested report buckets and producing the SAME
  `TimeseriesReport` shape as the raw scan — and transparently falls back to the
  raw scan for tag-filtered queries and non-rollup stores.

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

- [`593bcc8`](https://github.com/DavideCarvalho/nestjs-telescope/commit/593bcc85ad6558040c62ba66bd1e5e0cbe5a6ac7) - Make the SQS queue `dlqUrl` **optional**, reflecting real AWS where many queues
  have no dead-letter queue. The primary value — live queue **depth**
  (`waiting`/`active`/`delayed`, the latter now read from
  `ApproximateNumberOfMessagesDelayed`) — is always reported from the main queue,
  with or without a DLQ. DLQ inspection (`listJobs('failed')`) and `redrive` are now
  a bonus, available only for queues configured with a `dlqUrl`:

  - Without a `dlqUrl`: `failed` is `0`, `listJobs('failed')` returns an empty page,
    and `redrive` throws `Queue "<name>" has no DLQ configured; redrive unavailable`.
  - Each queue's `QueueSummary` now advertises an optional `actions` capability hint
    (`['redrive']` when a DLQ is configured, otherwise `[]`) so the UI can show the
    Redrive button only for queues that support it. Adds the optional
    `actions?: QueueActionName[]` field to `QueueSummary` in core.

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

### Patch Changes

- [`80c8f97`](https://github.com/DavideCarvalho/nestjs-telescope/commit/80c8f9769c8ab9ee724635086740910bc4d44ea3) - Scan the analytics window in large pages (5000, was 500). The metrics window
  scan is the only caller; small pages turned one scan into many sequential
  round-trips, which dominated latency against a remote SQL store. A big page
  collapses a typical window into one or two queries — the real win for remote
  RDS, complementing the content projection.
