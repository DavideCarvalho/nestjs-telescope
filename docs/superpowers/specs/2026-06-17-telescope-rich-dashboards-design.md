# Telescope rich dashboards — beautiful, meaningful, realtime

**Date:** 2026-06-17
**Status:** Design (approved direction; pending spec review)
**Scope:** Sub-project 1 of 3 — the *engine* (panel IR + rendering + layout + realtime SSE), proven by redesigning the durable **Workflows** dashboard. Sub-projects 2 (authz dashboard) and 3 (inertia dashboard) are separate specs that reuse this engine.

## 1. Problem

The extension dashboard SPI (shipped in `@dudousxd/nestjs-telescope@1.8.0`) renders panels via a declarative IR (`stat`/`timeseries`/`topN`/`table`), and `nestjs-durable-telescope` is its first consumer (the "Workflows" tab). Two problems:

1. **It's visually flat.** `ExtensionDashboardPage` renders every panel in a uniform `grid-cols-1 md:grid-cols-2` with no hierarchy. `StatCard` is a label + a number — it ignores the `delta` the IR already returns, has no sparkline, and no health/threshold coloring. There are only five panel kinds, so meaningful ops signals (latency percentiles, distributions, state breakdowns, success-rate gauges) cannot be expressed.
2. **The metrics aren't decision-useful.** Today's Workflows panels are mostly raw counters (total/failed/pending/dead). They don't answer the maintenance questions: *is it healthy? what's degrading? what should I fix?*
3. **It's not realtime.** "Live-tail" is just React-Query `refetchInterval` polling. There is no server push, so dashboards feel stale.

## 2. Goals / non-goals

**Goals**
- Make extension dashboards **beautiful**: visual hierarchy, threshold/health coloring, trend deltas, sparklines, real charts (recharts is already a UI dependency).
- Make metrics **meaningful for maintenance**, organized as **golden signals + "what to fix"**: a health row at a glance, then triage (hotspots), then trends.
- Add **realtime via SSE**: panels update the instant relevant entries are recorded, with graceful fallback to polling.
- Prove all of it by **redesigning the durable Workflows dashboard**.

**Non-goals (this sub-project)**
- authz and inertia dashboards (separate specs, reuse this engine).
- Per-user dashboard customization, drag-and-drop layout, saved views.
- A general charting/query language beyond the panel IR additions below.

## 3. Architecture

All engine work lands in **`nestjs-telescope`** (`packages/core` for the IR types + SSE endpoint; `packages/ui` for rendering). The flagship dashboard work lands in **`nestjs-durable` `packages/telescope`** (new/extended providers + the redesigned `DashboardSpec`), consuming the new IR.

The pull-based data model is unchanged: panels bind to named `DataProvider`s resolved server-side via `ctx.moduleRef`. The additions are (a) richer panel kinds, (b) an SSE invalidation channel that triggers re-resolution, (c) a sectioned layout, (d) new providers that compute meaningful aggregates from already-captured data.

## 4. Panel IR additions (`packages/core/src/extension/types.ts`)

Keep `topN`, `table`, `timeseries` (with existing `area`/`stacked`). Changes:

### 4.1 `stat` — enriched (backward compatible)
Add optional fields; existing `stat` panels keep working.
- `delta` is **rendered** (today it's dropped): the provider's `{ value, delta?, deltaLabel? }` shows an up/down arrow + the delta, colored by direction.
- `spark?: boolean` — when true, the provider additionally returns `spark: number[]` and the card renders a sparkline.
- `thresholds?: { warn: number; bad: number; direction: 'up-bad' | 'down-bad' }` — drives accent/border color green→amber→red. `direction` says whether higher or lower is worse (e.g. p95 latency is `up-bad`; success rate is `down-bad`).
- `format` extended with `'rate'` (per-hour/min) alongside existing `number`/`percent`/`duration`.

Provider return for enriched stat: `{ value: number; delta?: number; deltaLabel?: string; spark?: number[] }`.

### 4.2 `distribution` — new
Histogram of a value (e.g. run duration) with percentile markers.
- Panel: `{ kind: 'distribution'; title; data; markers?: ('p50'|'p95'|'p99')[]; format?: 'duration'|'number' }`.
- Provider return: `{ buckets: Array<{ label: string; count: number }>; p50?: number; p95?: number; p99?: number }`.

### 4.3 `gauge` — new
Radial/arc gauge for a bounded ratio (e.g. success rate, saturation).
- Panel: `{ kind: 'gauge'; title; data; min?: number; max?: number; format?; thresholds?: {warn; bad; direction} }`.
- Provider return: `{ value: number; min?: number; max?: number }`.

### 4.4 `breakdown` — new (donut)
Composition of a whole (e.g. runs by state).
- Panel: `{ kind: 'breakdown'; title; data; style?: 'donut' | 'bar' }`.
- Provider return: `{ segments: Array<{ label: string; value: number; color?: string }> }`.

All new kinds follow the existing rules: pure declarative, provider-resolved, no React shipped by the extension. Semver: telescope is `0.x` for the SPI surface (per `types.ts` remark) — these are additive and land as a `minor`.

## 5. Realtime via SSE

### 5.1 Server (`packages/core`)
A Nest `@Sse('/api/stream')` endpoint (auth-gated like the rest of the dashboard API) returns an `Observable<MessageEvent>` that emits **invalidation ticks**, not payloads:

```
{ types: string[] }   // e.g. { types: ['durable'] } — entry types that just changed
```

A lightweight in-process event bus fires when the recording pipeline persists entries; the stream debounces (~250–500ms) and coalesces types so a burst of records produces one tick. Heartbeat comment every ~15s to keep the connection alive through proxies. No durable per-client state; the stream is stateless and reconnect-safe.

### 5.2 Client (`packages/ui`)
A single `EventSource` to `/api/stream`. On each tick, invalidate the React-Query keys for any mounted panel whose provider belongs to an affected type (panels already know their `ext`; dashboards map to a type). React Query then re-resolves only those panels through the **existing** `useExtensionData` path — so SSE replaces the dumb interval with event-driven invalidation while reusing all data plumbing.
- **Fallback:** if the `EventSource` errors/closes and can't reconnect, fall back to the current `refetchInterval` polling. The live-tail pause toggle still freezes updates (ignore ticks while paused).
- A **● LIVE** indicator in the dashboard header reflects SSE connection state (live / reconnecting / polling).

## 6. Workflows dashboard redesign (`nestjs-durable/packages/telescope`)

Organized golden-signals-first. Layout sections (see §7):

**Health row (4× enriched `stat`/`gauge`)** — each with delta vs the previous equal-length window + sparkline + threshold color:
- **Success rate** (`gauge` or `stat`, `down-bad`) — completed / (completed+failed) over window.
- **p95 duration** (`stat`, `up-bad`) — 95th percentile of run duration.
- **Backlog** (`stat`, `up-bad`) — current `pending` count (state store). The sparkline/delta is derived from entries (a time-bucketed estimate of in-flight runs: cumulative `run.started` minus `run.completed`/`run.failed` per bucket); if that estimate isn't reliable, render the value without a delta rather than fabricate one.
- **Throughput** (`stat`, format `rate`) — completed runs per hour over window.

**Needs attention (triage)**
- **Top failing workflows** (`topN`) — by failure count/rate.
- **Stuck runs** (`table`) — dead/suspended within window, deep-linked to the durable dashboard (existing `recentFailures` provider, extended to include dead/suspended + age).
- **Steps with most retries** (`topN`) — *depends on the watcher capturing a step attempt/retry count; see §9 risk. If unavailable, this panel is deferred to a follow-up rather than faked.*

**Trends**
- **Runs over time** (`timeseries`, `stacked`) — done vs failed, time-bucketed.
- **Duration distribution** (`distribution`) — p50/p95/p99 markers.
- **Runs by state** (`breakdown` donut) — running/pending/done/failed/dead snapshot from the state store.

## 7. Rendering & layout (`packages/ui`)

- **Sectioned layout** replaces the uniform grid: a `DashboardSpec` gains optional `sections?: Array<{ title?: string; panels: Panel[]; cols?: 2|3|4 }>` (back-compat: a spec with a flat `panels` array still renders as one section). `ExtensionDashboardPage` renders sections with their own responsive column counts.
- **`StatCard` rewrite**: value + delta arrow (colored by direction) + optional sparkline + threshold accent (green/amber/red border or top accent bar). Reuses the existing dark zinc/sky palette, elevated with health colors.
- New chart cards: `GaugeCard`, `DistributionCard` (histogram + percentile reference lines), `BreakdownCard` (donut), built on recharts; `PanelView` switch extended for the new kinds.
- Keep the per-panel independent fetch + inline error-card degradation that already exists.

## 8. Testing

- **Providers** (durable): percentile computation, time-bucketing, delta-vs-previous-window, duration pairing (`run.started`→`run.completed` by `runId`), backlog/state gauges — with fixtures of captured entries + a fake state store.
- **IR / PanelView**: each new kind (`distribution`/`gauge`/`breakdown`) and enriched `stat` (delta/spark/threshold) renders from resolved data; thresholds pick the right color; sections render with correct column counts.
- **SSE**: the server stream emits a coalesced tick on a recorded-entry event and a heartbeat; the client hook invalidates the right query keys on a tick and falls back to polling on error. Tested at the hook/registry level (the repo's established pattern — no supertest in durable).
- Existing telescope core/ui + durable-telescope suites stay green.

## 9. Risks / open items

- **Retry hotspots** need a per-step attempt/retry count. The durable watcher captures step events but may not record attempts. If it doesn't, either (a) enrich the watcher to include `attempt`/`retries` on step entries (small, additive), or (b) defer that one panel to a follow-up. Decide during planning; do not fake the metric.
- **SSE behind proxies/load balancers**: heartbeats + reconnect + polling fallback mitigate; document that `text/event-stream` must not be buffered by an intermediary.
- **Provider cost**: percentile/bucketing reads bounded entry pages (cap like the existing providers, e.g. ≤5k) — these are history/rollup series, not source-of-truth; document the bound.

## 10. Rollout

Additive `minor` on `@dudousxd/nestjs-telescope` (IR + UI + SSE) and on `@dudousxd/nestjs-durable-telescope` (redesigned dashboard + providers). No breaking changes: existing extensions (flat `panels`, old `stat`) keep working; SSE degrades to polling.

## 11. Out of scope (future specs)
- **Sub-project 2:** authz dashboard over `aviary:authz:decision` diagnostic entries (deny rate, denials by reason, top denied abilities/resources).
- **Sub-project 3:** inertia dashboard over `aviary:inertia:render` (p95 render, payload-size distribution, partial-reload ratio, version-mismatch/deploy-skew rate, heavy components).
- Both reuse this engine (panel IR + SSE + layout); they add providers over the generic diagnostic entries and their own `DashboardSpec`.
