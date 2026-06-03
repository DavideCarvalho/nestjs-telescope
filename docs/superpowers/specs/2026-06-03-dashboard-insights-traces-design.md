# Dashboard Insights, Charts & Trace Grouping — Design

**Date:** 2026-06-03
**Status:** Approved-in-spirit (Davi: "bora deixar completo vai" + 4 concrete asks). Build via subagent-driven.

## Goal

Make the Telescope dashboard feel *complete* (Laravel Telescope / Pulse / Horizon
grade): per-type analytical headers with charts, explicit cache hit/miss, a fixed
Schedule view, query latency percentiles per shape, and entry grouping by OTel
trace. Four user asks, one milestone.

## Existing building blocks (reuse, don't reinvent)

- `core/src/metrics/collect-window.ts` → `collectEntriesInWindow(storage, {after,type,...})` — bounded window scan (storage-agnostic).
- `core/src/metrics/timeseries.ts` → `bucketTimeseries(entries, start, end, buckets)` — over-time bucketing. Exposed via `TimeseriesService` + `GET /timeseries`.
- `core/src/pulse/pulse-summary.ts` → `summarizePulse` (per-type counts, slowest entries, exception groups, N+1). Via `PulseService` + `GET /pulse`.
- `ui/src/react/components/charts/*` → Recharts cards: `area-chart-card`, `bar-chart-card`, `stacked-area-chart-card`, `chart-card`, `chart-theme`. Already isolated, pinned.
- Entries page `ui/src/app/pages/entries-page.tsx` at `#/entries/:type`; nav from `entry-types.ts` (`ENTRY_TYPES`).
- Entry already carries `durationMs`, `familyHash`, type-specific `content`, and now `traceId`/`spanId`.

## Part 1 — Schedule fix (small)

**Root cause:** `ScheduleWatcher` records each scheduled run as `type=EntryType.Job`
with `familyHash='schedule:<name>'`, `content.queue='schedule'`, tags
`['schedule:<label>','task:<name>']` (+ `failed`/`slow`). The UI "Schedule" nav
queries `type='schedule'` (a type that is never emitted) → always 0. (Also: flip
had simply not fired a cron yet — but the view would be empty even with runs.)

**Fix:**
- Lib `ScheduleWatcher`: add a stable plain `'schedule'` tag to the entry (alongside the existing `schedule:<label>`), so the run is filterable without parsing the labelled tag.
- `EntryTypeDef` gains an optional `query?: { type?: string; tag?: string }`. The `schedule` entry sets `query: { type: 'job', tag: 'schedule' }`. `EntriesPage` (and the per-type insights) use `def.query ?? { type: def.id }` when fetching. Nav label/dot unchanged.
- Result: the Schedule tab lists scheduled-run job entries; Jobs tab still lists all jobs (incl. schedule) — acceptable, or optionally the Jobs view could exclude `tag=schedule` later (out of scope now).

## Part 2 — Per-type insights endpoint (`GET /stats`) + `StatsService`

A storage-agnostic aggregate computed on demand from a window of entries (same
pattern as Pulse/Timeseries — no live counters).

**`StatsService.getStats({ type, windowMs, buckets? })` → `StatsResult`:**

```ts
interface LatencyStats { count: number; p50: number; p95: number; p99: number; max: number; slow: number; }
interface FamilyLatency { familyHash: string; label: string; count: number; p99: number; p50: number; }
interface CacheStats { hits: number; misses: number; sets: number; hitRatio: number; topKeys: { key: string; count: number }[]; }
interface StatusBreakdown { '2xx': number; '3xx': number; '4xx': number; '5xx': number; other: number; }

interface StatsResult {
  type: string;
  windowMs: number;
  total: number;
  overTime: TimeseriesReport;          // reuse bucketTimeseries (count per bucket; cache → hits vs misses series)
  latency?: LatencyStats;              // query | request | job | http_client (types with durationMs)
  families?: FamilyLatency[];          // query: top families by p99 (the "per table/shape" view)
  cache?: CacheStats;                  // cache only
  status?: StatusBreakdown;            // request only
  truncated: boolean;                  // window scan hit the cap
}
```

- **Percentiles** computed in JS over the window's `durationMs` array (sort + index). Bounded by `collectEntriesInWindow`'s existing cap; set `truncated` when the cap is hit and the UI shows a subtle "sampled" note.
- **families**: group query entries by `familyHash`, compute per-group p50/p99/count, `label` = a short representative SQL (first ~60 chars of `content.sql`), return top N (default 8) by p99. This is the "p50/p99 por tabela" Davi asked for (a query family ≈ a table/shape).
- **cache.overTime**: a hits-vs-misses two-series report (reuse the stacked bucket shape) instead of a single count series.
- Endpoint: `GET /telescope/api/stats?type=<t>&window=<dur>` (window parsed like `/timeseries`). Reuses the read `TelescopeActionGuard`/authorizer like other read routes.

## Part 3 — UI per-type insights header + cache badges

A new `<EntryInsights type=...>` component rendered above the table on
`#/entries/:type`, fetching `/stats` (React Query, polling like the rest). Each
type renders the charts that make sense; everything gets *something* so the
dashboard feels complete:

- **Queries:** stat cards (count, p50, p99, slow %) + `bar-chart-card` "Slowest query shapes (p99)" (families) + `area-chart-card` "Queries over time".
- **Cache:** stat cards (hit ratio, hits, misses, sets) + `stacked-area-chart-card` "Hits vs misses over time" + `bar-chart-card` "Top keys". **Plus** a per-row hit/miss **badge** in the cache table: green `HIT` / amber `MISS` / zinc `SET` (from `content.operation`/`content.hit`), and the same on the entry detail.
- **Requests:** stat cards (count, p99, error %) + `bar-chart-card` "Status codes" + `area-chart-card` "Throughput".
- **Jobs / Mail / Exceptions / Schedule / HTTP Client:** a light generic header — count stat + `area-chart-card` "Over time" (+ for jobs: failed count; for exceptions: top groups via existing pulse data if cheap). Keeps the UI uniform without overbuilding.

Insights are additive — the existing filter bar + table stay exactly as they are
below the header.

## Part 4 — Trace grouping (ties into the OTel work)

**Backend:** `EntryQuery` gains `traceId?: string`. Each storage filters by it:
- in-memory: predicate.
- sqlite: `where trace_id = ?`.
- mikro-orm: `{ traceId }` in the query.
- redis: include in the scan predicate.
`GET /telescope/api/entries?traceId=<id>` then works (the controller already maps query params to `EntryQuery`; add `traceId`).

**UI:** a `#/traces/:traceId` route showing all entries that share the trace,
time-ordered, across types (a "trace timeline" — request + its queries + cache +
jobs together). Reuse the existing entry-list row rendering with the type dot.
From any entry-detail Trace row, add an internal **"View all in this trace"** link
→ `#/traces/:traceId` (the external Jaeger deep-link stays alongside it).

## Testing

- **core:** StatsService percentile math (known arrays → exact p50/p95/p99), family grouping/ordering, cache hit/miss/ratio, status bucketing, `truncated` flag; `/stats` controller route (params → service, validation). Schedule watcher emits the `schedule` tag. `EntryQuery.traceId` filter in each storage's spec (round-trip: store mixed traces, filter by one).
- **ui:** `EntryInsights` renders the right cards per type (mock `/stats`); cache badge states (hit/miss/set); the trace page lists only same-trace entries and the detail "view in trace" link points to `#/traces/:id`. Schedule nav fetches `{type:'job',tag:'schedule'}`.

## Out of scope (later)

- Storage-level SQL percentile aggregation (window-scan JS is enough and storage-agnostic).
- Cross-trace flamegraph / waterfall timing (we list entries, not a span waterfall — Jaeger owns that).
- Configurable chart windows beyond a sensible default + a couple presets.

## Rollout

Lib green (build/test/lint) → repack cache-bust tarballs (core, ui, schedule; mikro-orm only if the traceId filter touches it — it does) → flip `telescope-local` reboot → verify: Schedule tab populated after a cron run (or a manual trigger), cache badges + charts, query p50/p99 families, and a trace page grouping a request with its queries. No push/publish without Davi's OK.
