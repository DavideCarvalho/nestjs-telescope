# Dashboard Insights, Charts & Trace Grouping — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps are checkboxes.

**Goal:** Per-type insight headers with charts, explicit cache hit/miss, fixed Schedule view, query latency percentiles per shape, and entry grouping by OTel trace.

**Spec:** `docs/superpowers/specs/2026-06-03-dashboard-insights-traces-design.md` (read it — this plan is the task breakdown; reuse the existing building blocks it lists).

**Conventions:** No `as`/`unknown`/`never`/`any` in source; fixed dep versions; `function` decls; `.js` specifiers; no Co-Authored-By; commit per task; whole-repo `pnpm -w build && pnpm -w test && pnpm -w lint` green at the end of each phase.

---

## Phase 1 — Schedule fix + traceId filter (small, unblocks traces)

### Task 1.1 — ScheduleWatcher emits a stable `schedule` tag
**Files:** `packages/schedule/src/schedule.watcher.ts` (+ its spec).
- In the `tags` array built for the job entry, add a plain `'schedule'` tag alongside the existing `schedule:<label>`/`task:<name>`.
- Update/extend the watcher spec to assert the recorded entry's tags include `'schedule'`.
- Commit: `fix(schedule): tag scheduled runs with a stable 'schedule' tag`.

### Task 1.2 — `EntryQuery.traceId` filter across all storages
**Files:** `packages/core/src/storage/storage-provider.ts` (`EntryQuery`), `in-memory-storage-provider.ts`, `sqlite-storage-provider.ts`, `packages/mikro-orm/src/mikro-orm-storage.provider.ts`, `packages/redis/src/redis-storage-provider.ts`, and the controller's entries route (`telescope.controller.ts` — map `@Query('traceId')`). Plus each storage's spec.
- Add `traceId?: string` to `EntryQuery`.
- in-memory: add to the predicate. sqlite: `and trace_id = @traceId` when present. mikro-orm: add `traceId` to the where. redis: include in the scan filter.
- Controller `GET /entries`: read `traceId` query param into the `EntryQuery`.
- Tests: store entries across 2 trace ids + some null; filter by one trace id → only its entries (each storage spec; reuse existing harnesses).
- Commit: `feat(core): filter entries by traceId across storages`.

---

## Phase 2 — StatsService + `GET /stats`

### Task 2.1 — Stats aggregation (pure functions) + percentiles
**Files:** Create `packages/core/src/metrics/stats.ts` (pure: `summarizeStats(entries, {type, windowStart, windowEnd, buckets, slowMs, topFamilies, topKeys})` → `StatsResult`) + `stats.spec.ts`. Reuse `bucketTimeseries` for `overTime`.
- Implement `percentile(sortedNumbers, q)` (nearest-rank or linear — pick one, test exact values).
- Build `LatencyStats` from `durationMs` of entries that have it; `families` (group query by `familyHash`, p50/p99/count, label = first 60 chars of `content.sql`, top by p99); `CacheStats` (hits/misses/sets/ratio/topKeys from `content.operation`/`hit`/`key`); `StatusBreakdown` (request `content.statusCode` → 2xx..5xx/other). Set `truncated` from the caller.
- Types exactly as the spec's `StatsResult`/`LatencyStats`/`FamilyLatency`/`CacheStats`/`StatusBreakdown`.
- Tests: known arrays → exact p50/p95/p99/max; family grouping + ordering; cache ratio incl. zero-division guard (ratio 0 when no gets); status bucketing; empty window.
- Commit: `feat(core): stats aggregation with latency percentiles`.

### Task 2.2 — `StatsService` + `GET /stats` endpoint
**Files:** Create `packages/core/src/metrics/stats.service.ts` (mirror `TimeseriesService`: inject storage + config, `getStats({type, windowMs, buckets?})`, scan via `collectEntriesInWindow`, call `summarizeStats`, set `truncated`). Wire it as a provider in `telescope.module.ts`. Add `GET /stats` to `telescope.controller.ts` (parse `type`, `window` like `/timeseries`; default window e.g. 1h). Export from index. Specs for service + controller route.
- Tests: service returns aggregates for a seeded store; controller maps params, validates window, returns the typed result; mirror `telescope.controller.timeseries.spec.ts`.
- Commit: `feat(core): StatsService + GET /stats endpoint`.

---

## Phase 3 — UI insights headers + cache badges

### Task 3.1 — Stats client + `useStats` hook + `StatsResult` client type
**Files:** `packages/ui/src/client/telescope-client.ts` (add `stats(type, window)`), `packages/ui/src/client/types.ts` (`StatsResult` mirror), `packages/ui/src/react/use-telescope-queries.ts` (`statsQuery`/`useStats`, polling like `useEntries`). Spec the client method + hook wiring (mirror existing).
- Commit: `feat(ui): stats client + useStats hook`.

### Task 3.2 — `EntryInsights` component (charts per type)
**Files:** Create `packages/ui/src/react/components/entry-insights.tsx` (+ spec). Reuse `charts/*` cards + a small stat-card. Render per the spec's per-type layout (queries/cache/requests rich; jobs/mail/exception/schedule/http get count + over-time). Show a subtle "sampled" note when `truncated`.
- Render it above the table in `entries-page.tsx`.
- Tests: mock `/stats`, assert the right cards per type render; truncated note shows.
- Commit: `feat(ui): per-type insights header with charts`.

### Task 3.3 — Schedule nav query override + cache hit/miss badge
**Files:** `packages/ui/src/react/components/entry-types.ts` (`EntryTypeDef.query?`, set `query:{type:'job',tag:'schedule'}` on the schedule entry), `entries-page.tsx` (use `def.query ?? {type:def.id}`), the cache table row + `entry-detail.tsx` (HIT/MISS/SET badge from `content`). Specs.
- Tests: schedule nav fetches `{type:'job',tag:'schedule'}`; badge renders HIT/MISS/SET correctly.
- Commit: `feat(ui): schedule view via job+tag query and cache hit/miss badges`.

---

## Phase 4 — Trace grouping UI

### Task 4.1 — Trace page + "view in trace" link
**Files:** `packages/ui/src/app/pages/trace-page.tsx` (new), `App.tsx` route `#/traces/:traceId`, `entry-detail.tsx` (internal "View all in this trace" link → `#/traces/:traceId`, beside the external Jaeger link). Reuse the entry-list row rendering. Fetch via `useEntries({ traceId })` (extend the entries client/hook to pass `traceId`).
- Tests: trace page lists only same-trace entries (mock); detail link points to `#/traces/:id`.
- Commit: `feat(ui): trace grouping page + view-in-trace link`.

---

## Phase 5 — Green + dogfood

- [ ] Whole-repo `pnpm -w build && pnpm -w test && pnpm -w lint` green. Changeset (`core` minor, `schedule` patch, `mikro-orm`/`redis` patch, `ui` minor).
- [ ] Repack cache-bust tarballs (core, ui, schedule, mikro-orm, redis) → flip `telescope-local`, `pnpm install`, build, reboot. Verify: cache badges + hit/miss chart; query p50/p99 families; Schedule tab populated (trigger a cron or wait); a trace page grouping a request with its queries. No push/publish without Davi's OK.
