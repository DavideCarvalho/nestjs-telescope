# Horizon Phase 3 — Overview Dashboard + Recharts — Plan

> Sub-skill: superpowers:subagent-driven-development. Design contract: `docs/superpowers/specs/2026-06-03-horizon-queue-management-design.md`.

**Goal:** Give the `-ui` dashboard a Laravel-Telescope/Horizon-grade Overview landing page and rich Recharts charts, on the EXISTING read data (`/pulse`, `/queues`, `/timeseries`, `/entries`). No new backend. Dark aesthetic, polling.

**Package:** `packages/ui` (bundled React SPA: `src/client` typed client, `src/react` hooks+components, `src/app` Vite app/pages/layout; build = `vite build && tsc lib && tsc server`; libs are bundled via **devDependencies**). Follow existing conventions exactly (options-returning hooks `xxxQuery()`/`useXxx()`, `createTelescopeClient` `get<T>`, dark theme, HashRouter routing in `src/app/App.tsx`, nav in `src/app/dashboard-layout.tsx`).

## Tasks

### Task 1 — Add Recharts + a chart primitives layer
- Add `recharts` (pin EXACT latest 2.x version, no `^`) to `packages/ui` **devDependencies** (it's bundled into the SPA, not a consumer runtime dep). `pnpm install`.
- Create `src/react/components/charts/` with small dark-themed wrappers around Recharts so pages don't import Recharts directly: `AreaChartCard` (time-series area, gradient fill, hover tooltip, time x-axis), `StackedAreaChartCard` (multi-series stacked, legend), `BarChartCard` (categorical), and a shared `chart-theme.ts` (dark palette: bg transparent, grid `#ffffff10`, axis text muted, a per-type color map reusing the existing type colors if any). Each card: title + the chart, responsive (`ResponsiveContainer`), empty-state when no data.
- Export from `src/react/index.ts`.
- Test: a render spec per card (render with sample data in jsdom, assert it mounts without crashing + shows the title). Recharts needs width/height — use a fixed `width/height` prop path or mock `ResponsiveContainer` as the existing specs do for sized SVG; if ResponsiveContainer renders nothing in jsdom (0x0), pass explicit `width`/`height` in the test or wrap so the chart has dimensions.
- Commit `feat(ui): add Recharts chart primitives (dark themed)`.

### Task 2 — Overview page (Horizon-style landing)
- Create `src/app/pages/OverviewPage.tsx`: the new landing route. Sections:
  1. **Stat cards row** — totals/health from `usePulse()` + `useQueues()`: e.g. total entries (by-type sum), requests, exceptions (failures), jobs/min throughput, failed jobs, slow count. Compact cards with big numbers + a muted label + subtle trend where available.
  2. **Throughput over time** — `AreaChartCard` fed by `useTimeseries()` total series.
  3. **By-type stacked** — `StackedAreaChartCard` from `useTimeseries()` byType.
  4. **Recent failures** + **Slowest** — small lists from `usePulse()` (topExceptions, slowest), linking to the entry detail route.
  - Polling via the existing hooks' refetch interval (match current dashboard cadence). WindowSelect at the top controls the window for the time-based widgets.
- Wire it as the index route in `src/app/App.tsx` (the existing first view becomes reachable from nav; Overview is `#/`). Add an "Overview" nav item in `dashboard-layout.tsx` (first).
- Test: render OverviewPage with a QueryClient + mocked client returning sample pulse/queues/timeseries; assert the stat numbers + chart titles render. Reuse the existing test harness pattern (look at `pulse-panel.spec.tsx`).
- Commit `feat(ui): add Horizon-style Overview page`.

### Task 3 — Re-skin Pulse + Queues with Recharts
- Update `pulse-panel.tsx`: replace the zero-dep `Sparkline`/`StackedBars` usages with the new Recharts cards where it improves clarity (keep the data wiring; swap the viz). Keep the panel's existing data hooks.
- Update `queues-panel.tsx`: per-queue throughput/failure as a small Recharts chart (e.g. `BarChartCard` of failureRate / `AreaChartCard` of per-queue timeseries via the existing `tag:queue:<name>` filter), keeping the table of runtime/wait p95.
- Leave the old `sparkline.tsx`/`stacked-bars.tsx` files in place if still imported elsewhere; only remove if fully unused (check imports first).
- Tests: update the affected panel specs to the new components (render-without-crash + key labels).
- Commit `feat(ui): re-skin Pulse + Queues panels with Recharts`.

### Task 4 — Gate
- `cd packages/ui && pnpm test && pnpm typecheck && pnpm build` (the `vite build` MUST succeed — Recharts bundles; watch bundle errors) + `pnpm exec biome check src`.
- Whole-repo `pnpm -w build` green (the ui `vite build` is the long pole).
- Commit any doc note if needed. (No changeset needed if Phase 4 ships the -ui changeset together; optional `.changeset/horizon-ui-overview.md` minor `@dudousxd/nestjs-telescope-ui`.)

## Acceptance
- `#/` shows a polished dark Overview: stat cards + throughput area + by-type stacked + recent failures/slowest.
- Pulse/Queues use Recharts.
- `vite build` succeeds; whole repo builds; ui tests + typecheck + biome green.

## Notes
- Recharts in jsdom: `ResponsiveContainer` measures 0×0 → charts may render empty in tests. Either give tests explicit chart dimensions, or assert on the card title/legend wrapper rather than chart internals. Don't fight jsdom — test the React wiring, not pixel output.
- Keep Recharts imports ISOLATED to `src/react/components/charts/*` so the rest of the app stays chart-lib-agnostic (swap-friendly).
- Match the existing dark palette already used by the dashboard; don't introduce a new theme.
