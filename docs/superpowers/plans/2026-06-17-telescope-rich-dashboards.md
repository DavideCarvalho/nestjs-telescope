# Rich Telescope Dashboards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make telescope extension dashboards beautiful, meaningful (golden-signals), and realtime (SSE), proven by redesigning the durable Workflows dashboard.

**Architecture:** Additive changes to the declarative panel IR (enriched `stat`; new `distribution`/`gauge`/`breakdown`; `sections` layout) in `nestjs-telescope` core, mirrored in the UI client types and rendered with recharts. A Nest `@Sse` endpoint emits debounced "entry-type changed" invalidation ticks from the recorder's existing `onFlushStored` choke-point; the UI's `EventSource` invalidates only the affected React-Query keys, falling back to polling. The durable `-telescope` package gains providers (percentiles, throughput, deltas, buckets, state breakdown) and a redesigned `DashboardSpec`.

**Tech Stack:** TypeScript (NodeNext ESM), NestJS, RxJS (`@Sse`), React + @tanstack/react-query + recharts, vitest, pnpm workspaces, changesets, biome.

## Global Constraints

- Panel IR changes are **additive and backward compatible**: existing extensions using flat `panels` and plain `stat` must keep working unchanged.
- The core extension SPI is semver **0.x** (`types.ts` remark) — ship as a **minor**.
- Two repos: `nestjs-telescope` (core IR+SSE, ui rendering) and `nestjs-durable` (providers + dashboard). Telescope publishes first; durable consumes the published telescope minor (or a local `dist/` rsync for dev per the repo's established pattern).
- Run lint after edits: `pnpm lint` is biome (`biome check .`) — it WILL fail CI on formatting/import-order; run `pnpm exec biome check --write .` before committing.
- Never fabricate a metric: if `StepCheckpoint.attempts` is not queryable for retry-hotspots, that panel is omitted (not faked).
- Provider reads are bounded (cap entry pages ≤5_000 like existing providers).
- Commit message trailer on every commit: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Work on branch `spec/telescope-rich-dashboards` (telescope) / a matching feature branch in durable; never commit to `main` directly.

---

## File Structure

**nestjs-telescope:**
- `packages/core/src/extension/types.ts` — MODIFY: enrich `stat`, add `distribution`/`gauge`/`breakdown` Panel kinds, add `sections?` to `DashboardSpec`.
- `packages/core/src/sse/entry-events.ts` — CREATE: in-process entry-type event bus (`EntryEvents`).
- `packages/core/src/sse/stream.controller.ts` — CREATE: `@Sse('telescope/api/stream')` endpoint.
- `packages/core/src/nest/telescope.service.ts` — MODIFY: feed `EntryEvents` from the existing `onFlushStored` hook; expose `sections` in meta.
- `packages/core/src/nest/telescope.module.ts` (or wherever providers/controllers are registered) — MODIFY: register `EntryEvents` + `StreamController`.
- `packages/ui/src/client/types.ts` — MODIFY: mirror the new Panel kinds + `sections`.
- `packages/ui/src/react/components/extensions/stat-card.tsx` — MODIFY: delta + threshold + sparkline.
- `packages/ui/src/react/components/charts/distribution-chart-card.tsx` — CREATE.
- `packages/ui/src/react/components/charts/gauge-card.tsx` — CREATE.
- `packages/ui/src/react/components/charts/breakdown-card.tsx` — CREATE.
- `packages/ui/src/react/components/extensions/panel-renderer.tsx` — MODIFY: render new kinds + enriched stat.
- `packages/ui/src/react/use-telescope-stream.ts` — CREATE: `EventSource` → query invalidation + connection state.
- `packages/ui/src/app/pages/extension-dashboard-page.tsx` — MODIFY: sectioned layout + LIVE indicator.

**nestjs-durable:**
- `packages/telescope/src/durable-telescope.watcher.ts` — MODIFY: persist `durationMs` (and `attempts` if available) in entry content.
- `packages/telescope/src/durable-data-providers.ts` — MODIFY: add `successRate`(delta), `p95`/`distribution`, `throughput`, `backlogTrend`, `runsOverTime`, `stateBreakdown` (+`retryHotspots` if feasible).
- `packages/telescope/src/durable-dashboard.spec-data.ts` — MODIFY: redesign into sections.
- `packages/telescope/src/durable-telescope.extension.ts` — MODIFY: register any new providers.

---

## Task 1: Enrich the core Panel IR types

**Files:**
- Modify: `packages/core/src/extension/types.ts`
- Test: `packages/core/test/extension/panel-ir.spec.ts` (create)

**Interfaces:**
- Produces: enriched `stat` panel (`spark?`, `thresholds?`, `format` adds `'rate'`); new panels `{ kind: 'distribution' }`, `{ kind: 'gauge' }`, `{ kind: 'breakdown' }`; `DashboardSpec.sections?: Section[]` where `Section = { title?: string; cols?: 2|3|4; panels: Panel[] }`. Provider return shapes documented in the `DataProvider.resolve` jsdoc.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/test/extension/panel-ir.spec.ts
import { describe, expect, it } from 'vitest';
import { defineTelescopeExtension } from '../../src/extension/types.js';

describe('panel IR additions', () => {
  it('accepts enriched stat + new panel kinds + sections', () => {
    const ext = defineTelescopeExtension({
      name: 'demo',
      dashboards: () => [
        {
          id: 'demo.page',
          label: 'Demo',
          sections: [
            {
              title: 'Health',
              cols: 4,
              panels: [
                {
                  kind: 'stat',
                  title: 'Success',
                  data: { provider: 'demo.success' },
                  format: 'percent',
                  spark: true,
                  thresholds: { warn: 0.95, bad: 0.9, direction: 'down-bad' },
                },
                { kind: 'gauge', title: 'Sat', data: { provider: 'demo.sat' }, max: 1 },
              ],
            },
            {
              title: 'Trends',
              cols: 2,
              panels: [
                {
                  kind: 'distribution',
                  title: 'Duration',
                  data: { provider: 'demo.dur' },
                  markers: ['p50', 'p95', 'p99'],
                  format: 'duration',
                },
                { kind: 'breakdown', title: 'States', data: { provider: 'demo.states' }, style: 'donut' },
              ],
            },
          ],
          panels: [],
        },
      ],
    });
    const dash = ext.dashboards?.({} as never)[0];
    expect(dash?.sections?.[0].panels[0].kind).toBe('stat');
    expect(dash?.sections?.[1].panels[0].kind).toBe('distribution');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd nestjs-telescope && pnpm --filter @dudousxd/nestjs-telescope exec vitest run test/extension/panel-ir.spec.ts`
Expected: FAIL — type error (`spark`/`thresholds`/`distribution`/`gauge`/`breakdown`/`sections` not assignable).

- [ ] **Step 3: Implement the type changes**

In `packages/core/src/extension/types.ts`, replace the `Panel` union and extend `DashboardSpec`:

```typescript
/** Threshold coloring for a numeric panel. `direction` says which way is worse. */
export interface PanelThresholds {
  warn: number;
  bad: number;
  direction: 'up-bad' | 'down-bad';
}

export type Panel =
  | {
      kind: 'stat';
      title: string;
      data: DataBinding;
      format?: 'number' | 'percent' | 'duration' | 'rate';
      accent?: string;
      /** When true, the provider also returns `spark: number[]` and the card draws a sparkline. */
      spark?: boolean;
      thresholds?: PanelThresholds;
    }
  | {
      kind: 'timeseries';
      title: string;
      data: DataBinding;
      series: string[];
      style?: 'area' | 'stacked';
    }
  | { kind: 'topN'; title: string; data: DataBinding; limit?: number }
  | { kind: 'table'; title: string; data: DataBinding; columns: Column[] }
  | {
      kind: 'distribution';
      title: string;
      data: DataBinding;
      markers?: Array<'p50' | 'p95' | 'p99'>;
      format?: 'duration' | 'number';
    }
  | {
      kind: 'gauge';
      title: string;
      data: DataBinding;
      min?: number;
      max?: number;
      format?: 'number' | 'percent' | 'duration' | 'rate';
      thresholds?: PanelThresholds;
    }
  | { kind: 'breakdown'; title: string; data: DataBinding; style?: 'donut' | 'bar' };

/** A group of panels rendered together with its own column count. */
export interface DashboardSection {
  title?: string;
  cols?: 2 | 3 | 4;
  panels: Panel[];
}
```

Then in `DashboardSpec` add (keep `panels` for back-compat):

```typescript
export interface DashboardSpec {
  id: string;
  label: string;
  navGroup?: string;
  /** Flat layout (back-compat). Prefer `sections` for hierarchy. */
  panels: Panel[];
  /** Sectioned layout. When present, the UI renders these instead of `panels`. */
  sections?: DashboardSection[];
}
```

Update the `DataProvider.resolve` jsdoc to document the new shapes:
```
 *  - stat         → `{ value: number; delta?: number; deltaLabel?: string; spark?: number[] }`
 *  - distribution → `{ buckets: Array<{ label: string; count: number }>; p50?: number; p95?: number; p99?: number }`
 *  - gauge        → `{ value: number; min?: number; max?: number }`
 *  - breakdown    → `{ segments: Array<{ label: string; value: number; color?: string }> }`
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope exec vitest run test/extension/panel-ir.spec.ts`
Expected: PASS. Then `pnpm --filter @dudousxd/nestjs-telescope typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write packages/core/src/extension/types.ts packages/core/test/extension/panel-ir.spec.ts
git add packages/core/src/extension/types.ts packages/core/test/extension/panel-ir.spec.ts
git commit -m "feat(core): enrich panel IR — stat delta/spark/threshold + distribution/gauge/breakdown + sections

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Mirror new Panel/Section types in the UI client

**Files:**
- Modify: `packages/ui/src/client/types.ts`
- Test: `packages/ui/test/client/panel-types.spec.ts` (create)

**Interfaces:**
- Consumes: the shapes from Task 1.
- Produces: the UI `Panel` union + `DashboardSection` + `TelescopeMeta.dashboards[].sections` matching core byte-for-byte (this is the established cross-layer mirror).

- [ ] **Step 1: Write the failing test** — a structural assertion that the new kinds are assignable:

```typescript
// packages/ui/test/client/panel-types.spec.ts
import { describe, expect, it } from 'vitest';
import type { Panel } from '../../src/client/types.js';

describe('ui Panel mirror', () => {
  it('has the new kinds', () => {
    const kinds: Panel['kind'][] = ['stat', 'timeseries', 'topN', 'table', 'distribution', 'gauge', 'breakdown'];
    expect(kinds).toContain('distribution');
    const p: Panel = { kind: 'gauge', title: 'x', data: { provider: 'p' }, max: 1 };
    expect(p.kind).toBe('gauge');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope-ui exec vitest run test/client/panel-types.spec.ts`
Expected: FAIL — `'distribution'` not in `Panel['kind']`.

- [ ] **Step 3: Implement** — in `packages/ui/src/client/types.ts`, replace the `Panel` union with the same union as Task 1 (using the inline `data: { provider: string; query?: Record<string, unknown> }` shape this file already uses), add `PanelThresholds`, `DashboardSection`, and extend the `dashboards?` entry in `TelescopeMeta`:

```typescript
dashboards?: {
  id: string;
  label: string;
  navGroup?: string;
  panels: Panel[];
  sections?: { title?: string; cols?: 2 | 3 | 4; panels: Panel[] }[];
}[];
```

(Copy the `Panel` union and `PanelThresholds` verbatim from Task 1, but with `data: { provider: string; query?: Record<string, unknown> }` instead of `DataBinding`, matching this file's existing style.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope-ui exec vitest run test/client/panel-types.spec.ts && pnpm --filter @dudousxd/nestjs-telescope-ui typecheck`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write packages/ui/src/client/types.ts packages/ui/test/client/panel-types.spec.ts
git add packages/ui/src/client/types.ts packages/ui/test/client/panel-types.spec.ts
git commit -m "feat(ui): mirror enriched panel IR types

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: SSE entry-event bus + wire the recorder hook

**Files:**
- Create: `packages/core/src/sse/entry-events.ts`
- Modify: `packages/core/src/nest/telescope.service.ts` (the existing `onFlushStored` at ~lines 168–171)
- Modify: the module that provides core services (register `EntryEvents` as an injectable provider)
- Test: `packages/core/test/sse/entry-events.spec.ts` (create)

**Interfaces:**
- Produces: `class EntryEvents { emitTypes(types: string[]): void; stream(): Observable<string[]> }` (RxJS `Subject<string[]>`). The recorder's `onFlushStored(entries)` maps entries → unique `entry.type[]` → `entryEvents.emitTypes(types)`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/test/sse/entry-events.spec.ts
import { describe, expect, it, vi } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { take, toArray } from 'rxjs/operators';
import { EntryEvents } from '../../src/sse/entry-events.js';

describe('EntryEvents', () => {
  it('multicasts emitted type batches to subscribers', async () => {
    const bus = new EntryEvents();
    const got = firstValueFrom(bus.stream().pipe(take(2), toArray()));
    bus.emitTypes(['durable', 'request']);
    bus.emitTypes(['durable']);
    expect(await got).toEqual([['durable', 'request'], ['durable']]);
  });

  it('dedupes types within a batch', async () => {
    const bus = new EntryEvents();
    const got = firstValueFrom(bus.stream().pipe(take(1)));
    bus.emitTypes(['durable', 'durable', 'query']);
    expect((await got).sort()).toEqual(['durable', 'query']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope exec vitest run test/sse/entry-events.spec.ts`
Expected: FAIL — cannot find `EntryEvents`.

- [ ] **Step 3: Implement**

```typescript
// packages/core/src/sse/entry-events.ts
import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';
import type { Observable } from 'rxjs';

/**
 * Process-local bus of "entries of these types were just persisted". Fed from the
 * recorder's onFlushStored hook; consumed by the SSE stream to push invalidation
 * ticks. Stateless and best-effort — never throws into the flush path.
 */
@Injectable()
export class EntryEvents {
  private readonly subject = new Subject<string[]>();

  emitTypes(types: string[]): void {
    const unique = [...new Set(types)];
    if (unique.length === 0) return;
    try {
      this.subject.next(unique);
    } catch {
      // observability must never break the flush
    }
  }

  stream(): Observable<string[]> {
    return this.subject.asObservable();
  }
}
```

Register `EntryEvents` as a provider in the core module (same providers array as `TelescopeService`). In `telescope.service.ts`, inject `EntryEvents` and extend the existing `onFlushStored`:

```typescript
// in the recorder options where onFlushStored is defined (~line 168):
onFlushStored: (entries) => {
  this.diagnosis?.observeFlush(entries);
  this.entryEvents.emitTypes(entries.map((e) => e.type));
  return this.alerter?.evaluateFlush(entries);
},
```

(Add `@Inject(EntryEvents) private readonly entryEvents: EntryEvents` to the `TelescopeService` constructor.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope exec vitest run test/sse/entry-events.spec.ts`
Expected: PASS. Then `pnpm --filter @dudousxd/nestjs-telescope typecheck`.

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write packages/core/src/sse/entry-events.ts packages/core/src/nest/telescope.service.ts packages/core/test/sse/entry-events.spec.ts
git add -A
git commit -m "feat(core): EntryEvents bus fed from recorder onFlushStored

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: SSE stream endpoint

**Files:**
- Create: `packages/core/src/sse/stream.controller.ts`
- Modify: the core module (register `StreamController` alongside `TelescopeController`)
- Test: `packages/core/test/sse/stream.controller.spec.ts` (create)

**Interfaces:**
- Consumes: `EntryEvents.stream()` (Task 3).
- Produces: `@Sse('telescope/api/stream')` returning `Observable<{ data: { types: string[] } }>`, debounced ~300ms + coalesced, with a `merge`d heartbeat every 15s (`{ data: { heartbeat: true } }`). Guarded by `TelescopeGuard` (same as `TelescopeController`).

- [ ] **Step 1: Write the failing test** — debounce+coalesce of bursts:

```typescript
// packages/core/test/sse/stream.controller.spec.ts
import { describe, expect, it } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { filter, take } from 'rxjs/operators';
import { EntryEvents } from '../../src/sse/entry-events.js';
import { StreamController } from '../../src/sse/stream.controller.js';

describe('StreamController', () => {
  it('coalesces a burst into one tick carrying the union of types', async () => {
    const bus = new EntryEvents();
    const ctrl = new StreamController(bus);
    const tick = firstValueFrom(
      ctrl.stream().pipe(filter((m) => 'types' in (m.data as object)), take(1)),
    );
    bus.emitTypes(['durable']);
    bus.emitTypes(['durable', 'query']);
    const m = (await tick).data as { types: string[] };
    expect(m.types.sort()).toEqual(['durable', 'query']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope exec vitest run test/sse/stream.controller.spec.ts`
Expected: FAIL — cannot find `StreamController`.

- [ ] **Step 3: Implement**

```typescript
// packages/core/src/sse/stream.controller.ts
import { Controller, Inject, Sse, UseGuards } from '@nestjs/common';
import { type Observable, merge, timer } from 'rxjs';
import { bufferTime, filter, map } from 'rxjs/operators';
import { TelescopeGuard } from '../nest/telescope.guard.js';
import { EntryEvents } from './entry-events.js';

type StreamMessage = { data: { types: string[] } | { heartbeat: true } };

@UseGuards(TelescopeGuard)
@Controller()
export class StreamController {
  constructor(@Inject(EntryEvents) private readonly entryEvents: EntryEvents) {}

  @Sse('telescope/api/stream')
  stream(): Observable<StreamMessage> {
    // Coalesce bursts: collect type-batches over a 300ms window, emit one tick
    // with the union of types. Skip empty windows.
    const ticks = this.entryEvents.stream().pipe(
      bufferTime(300),
      filter((batches) => batches.length > 0),
      map((batches) => ({ data: { types: [...new Set(batches.flat())] } }) as StreamMessage),
    );
    const heartbeat = timer(15_000, 15_000).pipe(
      map(() => ({ data: { heartbeat: true } }) as StreamMessage),
    );
    return merge(ticks, heartbeat);
  }
}
```

Register `StreamController` in the core module's `controllers` array (next to `TelescopeController`). Confirm the guard import path `../nest/telescope.guard.js` matches the actual `TelescopeGuard` location (grep if unsure).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope exec vitest run test/sse/stream.controller.spec.ts`
Expected: PASS. Then `pnpm --filter @dudousxd/nestjs-telescope typecheck`.

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write packages/core/src/sse/stream.controller.ts packages/core/test/sse/stream.controller.spec.ts
git add -A
git commit -m "feat(core): @Sse invalidation stream (debounced + heartbeat)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: SSE client hook (EventSource → query invalidation)

**Files:**
- Create: `packages/ui/src/react/use-telescope-stream.ts`
- Test: `packages/ui/test/react/use-telescope-stream.spec.tsx` (create)

**Interfaces:**
- Produces: `useTelescopeStream(): { status: 'live' | 'connecting' | 'polling' }`. Opens an `EventSource` to `telescope/api/stream`; on a `types` tick, calls `queryClient.invalidateQueries({ queryKey: ['telescope', 'ext-data'] })` and `['telescope', 'meta']`; tracks connection status; on error → status `'polling'` (the existing `refetchInterval` keeps working).

- [ ] **Step 1: Write the failing test** (mock `EventSource`):

```typescript
// packages/ui/test/react/use-telescope-stream.spec.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTelescopeStream } from '../../src/react/use-telescope-stream.js';

class FakeES {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  close = vi.fn();
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  constructor(public url: string) { (FakeES as any).last = this; }
}

afterEach(() => vi.unstubAllGlobals());

describe('useTelescopeStream', () => {
  it('invalidates ext-data queries on a types tick', async () => {
    vi.stubGlobal('EventSource', FakeES);
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useTelescopeStream(), { wrapper });
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const es = (FakeES as any).last as FakeES;
    es.onopen?.();
    await waitFor(() => expect(result.current.status).toBe('live'));
    es.onmessage?.({ data: JSON.stringify({ types: ['durable'] }) });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['telescope', 'ext-data'] });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope-ui exec vitest run test/react/use-telescope-stream.spec.tsx`
Expected: FAIL — cannot find `useTelescopeStream`.

- [ ] **Step 3: Implement**

```typescript
// packages/ui/src/react/use-telescope-stream.ts
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

export type StreamStatus = 'connecting' | 'live' | 'polling';

/**
 * Subscribes to the telescope SSE stream and invalidates dashboard queries on each
 * tick, so panels re-resolve the instant new entries land. Falls back to the
 * existing polling (status 'polling') if SSE can't connect.
 */
export function useTelescopeStream(): { status: StreamStatus } {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<StreamStatus>('connecting');

  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      setStatus('polling');
      return;
    }
    const es = new EventSource('telescope/api/stream');
    es.onopen = () => setStatus('live');
    es.onerror = () => setStatus('polling');
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as { types?: string[]; heartbeat?: true };
        if (msg.heartbeat) return;
        if (msg.types && msg.types.length > 0) {
          queryClient.invalidateQueries({ queryKey: ['telescope', 'ext-data'] });
          queryClient.invalidateQueries({ queryKey: ['telescope', 'meta'] });
        }
      } catch {
        // ignore malformed frames
      }
    };
    return () => es.close();
  }, [queryClient]);

  return { status };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope-ui exec vitest run test/react/use-telescope-stream.spec.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write packages/ui/src/react/use-telescope-stream.ts packages/ui/test/react/use-telescope-stream.spec.tsx
git add -A
git commit -m "feat(ui): useTelescopeStream — SSE-driven query invalidation + status

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Rewrite StatCard (delta + threshold + sparkline)

**Files:**
- Modify: `packages/ui/src/react/components/extensions/stat-card.tsx`
- Test: `packages/ui/test/react/stat-card.spec.tsx` (create)

**Interfaces:**
- Produces: `StatCard({ label, value, delta?, deltaLabel?, spark?, thresholds?, currentValue?, format?, accent?, hint? })` — `value` is the preformatted string; `delta`/`deltaLabel` render an arrow colored by `thresholds.direction` (or neutral if no thresholds); `spark?: number[]` draws an inline SVG sparkline; `thresholds` + `currentValue` pick a top accent-bar color (emerald/amber/red).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/ui/test/react/stat-card.spec.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatCard } from '../../src/react/components/extensions/stat-card.js';

describe('StatCard', () => {
  it('renders a positive delta with an up arrow', () => {
    render(<StatCard label="Success" value="98.7%" delta={1.2} deltaLabel="1.2pp" />);
    expect(screen.getByText(/1\.2pp/)).toBeTruthy();
    expect(screen.getByText(/▲/)).toBeTruthy();
  });

  it('colors the accent red when currentValue crosses the bad threshold', () => {
    const { container } = render(
      <StatCard label="p95" value="3.0s" currentValue={3000}
        thresholds={{ warn: 1500, bad: 2500, direction: 'up-bad' }} />,
    );
    expect(container.querySelector('[data-health="bad"]')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope-ui exec vitest run test/react/stat-card.spec.tsx`
Expected: FAIL — `delta`/`thresholds` props don't exist; no `▲`.

- [ ] **Step 3: Implement**

```typescript
// packages/ui/src/react/components/extensions/stat-card.tsx
import type { JSX } from 'react';

export interface PanelThresholds {
  warn: number;
  bad: number;
  direction: 'up-bad' | 'down-bad';
}

function health(value: number | undefined, t?: PanelThresholds): 'ok' | 'warn' | 'bad' | null {
  if (value === undefined || !t) return null;
  const worseUp = t.direction === 'up-bad';
  if (worseUp ? value >= t.bad : value <= t.bad) return 'bad';
  if (worseUp ? value >= t.warn : value <= t.warn) return 'warn';
  return 'ok';
}

const ACCENT: Record<'ok' | 'warn' | 'bad', string> = {
  ok: '#34d399',
  warn: '#fbbf24',
  bad: '#f87171',
};

function Sparkline({ points }: { points: number[] }): JSX.Element | null {
  if (points.length < 2) return null;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * 100;
      const y = 20 - ((p - min) / span) * 18 - 1;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg className="mt-2" width="100%" height="22" viewBox="0 0 100 22" preserveAspectRatio="none" aria-hidden>
      <path d={d} fill="none" stroke="#52525b" strokeWidth="1.5" />
    </svg>
  );
}

export function StatCard({
  label,
  value,
  delta,
  deltaLabel,
  spark,
  thresholds,
  currentValue,
  accent = 'text-zinc-100',
  hint,
}: {
  label: string;
  value: string | number;
  delta?: number;
  deltaLabel?: string;
  spark?: number[];
  thresholds?: PanelThresholds;
  currentValue?: number;
  accent?: string;
  hint?: string;
}): JSX.Element {
  const h = health(currentValue, thresholds);
  // A positive delta is "good" unless higher is bad.
  const deltaGood = delta === undefined ? null : thresholds?.direction === 'up-bad' ? delta < 0 : delta > 0;
  const deltaColor = deltaGood === null ? '#a1a1aa' : deltaGood ? '#34d399' : '#f87171';
  const arrow = delta === undefined ? '' : delta > 0 ? '▲' : delta < 0 ? '▼' : '◆';
  return (
    <div
      data-health={h ?? undefined}
      className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3 overflow-hidden"
    >
      {h && <div style={{ height: 3, background: ACCENT[h], margin: '-12px -16px 9px' }} />}
      <p className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${accent} flex items-baseline gap-2`}>
        {value}
        {delta !== undefined && (
          <span className="text-xs font-semibold" style={{ color: deltaColor }}>
            {arrow} {deltaLabel ?? Math.abs(delta)}
          </span>
        )}
      </p>
      {spark && <Sparkline points={spark} />}
      {hint && <p className="mt-0.5 text-[10px] text-zinc-600">{hint}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope-ui exec vitest run test/react/stat-card.spec.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write packages/ui/src/react/components/extensions/stat-card.tsx packages/ui/test/react/stat-card.spec.tsx
git add -A
git commit -m "feat(ui): StatCard with delta arrow, threshold accent, sparkline

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: New chart cards — Distribution, Gauge, Breakdown

**Files:**
- Create: `packages/ui/src/react/components/charts/distribution-chart-card.tsx`
- Create: `packages/ui/src/react/components/charts/gauge-card.tsx`
- Create: `packages/ui/src/react/components/charts/breakdown-card.tsx`
- Test: `packages/ui/test/react/new-charts.spec.tsx` (create)

**Interfaces:**
- Produces:
  - `DistributionChartCard({ title, buckets: {label,count}[], p50?, p95?, p99?, height? })` — recharts `BarChart` + `ReferenceLine`s for percentiles.
  - `GaugeCard({ title, value, min?, max?, label?, color? })` — recharts `RadialBarChart` (or a semicircle) with the value.
  - `BreakdownCard({ title, segments: {label,value,color?}[], style? })` — recharts `PieChart` donut (or stacked bar when `style==='bar'`).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/ui/test/react/new-charts.spec.tsx
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DistributionChartCard } from '../../src/react/components/charts/distribution-chart-card.js';
import { GaugeCard } from '../../src/react/components/charts/gauge-card.js';
import { BreakdownCard } from '../../src/react/components/charts/breakdown-card.js';

describe('new chart cards', () => {
  it('render without throwing', () => {
    expect(() =>
      render(<DistributionChartCard title="Dur" buckets={[{ label: '0-1s', count: 5 }, { label: '1-2s', count: 3 }]} p95={1500} />),
    ).not.toThrow();
    expect(() => render(<GaugeCard title="Success" value={0.987} max={1} />)).not.toThrow();
    expect(() =>
      render(<BreakdownCard title="States" segments={[{ label: 'done', value: 90 }, { label: 'failed', value: 10 }]} />),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope-ui exec vitest run test/react/new-charts.spec.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement** — follow the existing chart-card pattern (`area-chart-card.tsx`: a titled card wrapper + `ResponsiveContainer`). Distribution:

```typescript
// packages/ui/src/react/components/charts/distribution-chart-card.tsx
import type { JSX } from 'react';
import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export function DistributionChartCard({
  title,
  buckets,
  p50,
  p95,
  p99,
  height = 200,
}: {
  title: string;
  buckets: { label: string; count: number }[];
  p50?: number;
  p95?: number;
  p99?: number;
  height?: number;
}): JSX.Element {
  const marks: Array<[number | undefined, string, string]> = [
    [p50, 'p50', '#34d399'],
    [p95, 'p95', '#fbbf24'],
    [p99, 'p99', '#f87171'],
  ];
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <p className="text-[10px] uppercase tracking-wide text-zinc-500 mb-2">{title}</p>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={buckets}>
          <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#71717a' }} />
          <YAxis tick={{ fontSize: 10, fill: '#71717a' }} allowDecimals={false} />
          <Tooltip contentStyle={{ background: '#18181b', border: '1px solid #27272a' }} />
          <Bar dataKey="count" fill="#0ea5e9" radius={[3, 3, 0, 0]} />
          {marks.map(([label, name, color]) =>
            label !== undefined ? (
              <ReferenceLine key={name} x={String(label)} stroke={color} strokeDasharray="3 3" label={{ value: name, fontSize: 9, fill: color }} />
            ) : null,
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
```

`GaugeCard` (recharts `RadialBarChart`) and `BreakdownCard` (recharts `PieChart` with `innerRadius` for donut; map `segments` to `Pie` data, default palette `['#34d399','#fbbf24','#f87171','#38bdf8','#a78bfa']` cycling, honoring `segment.color`). Both wrapped in the same titled card. Keep them small and self-contained.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope-ui exec vitest run test/react/new-charts.spec.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write packages/ui/src/react/components/charts/ packages/ui/test/react/new-charts.spec.tsx
git add -A
git commit -m "feat(ui): DistributionChartCard, GaugeCard, BreakdownCard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Extend PanelView for new kinds + enriched stat

**Files:**
- Modify: `packages/ui/src/react/components/extensions/panel-renderer.tsx`
- Test: `packages/ui/test/react/panel-renderer-new.spec.tsx` (create)

**Interfaces:**
- Consumes: `StatCard` (Task 6), the three chart cards (Task 7), the Panel union (Task 2).
- Produces: `PanelView` renders `distribution`/`gauge`/`breakdown` and passes `delta`/`deltaLabel`/`spark`/`thresholds`/`currentValue` from the resolved stat data into `StatCard`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/ui/test/react/panel-renderer-new.spec.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PanelView } from '../../src/react/components/extensions/panel-renderer.js';

describe('PanelView new kinds', () => {
  it('passes delta + spark into StatCard for enriched stat', () => {
    render(
      <PanelView
        panel={{ kind: 'stat', title: 'Success', data: { provider: 'p' }, format: 'percent', spark: true,
          thresholds: { warn: 0.95, bad: 0.9, direction: 'down-bad' } }}
        data={{ value: 0.987, delta: 0.012, deltaLabel: '1.2pp', spark: [0.9, 0.95, 0.98] }}
      />,
    );
    expect(screen.getByText(/1\.2pp/)).toBeTruthy();
  });

  it('renders a distribution panel', () => {
    expect(() =>
      render(
        <PanelView
          panel={{ kind: 'distribution', title: 'Dur', data: { provider: 'p' }, markers: ['p95'] }}
          data={{ buckets: [{ label: '0-1s', count: 4 }], p95: 1400 }}
        />,
      ),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope-ui exec vitest run test/react/panel-renderer-new.spec.tsx`
Expected: FAIL — distribution case missing; delta not passed.

- [ ] **Step 3: Implement** — in `panel-renderer.tsx`, update the `stat` case to read the richer provider shape and add the three new cases:

```typescript
case 'stat': {
  const d = (data ?? {}) as { value?: number; delta?: number; deltaLabel?: string; spark?: number[] };
  return (
    <StatCard
      label={panel.title}
      value={formatStat(d.value ?? 0, panel.format)}
      currentValue={d.value}
      {...(d.delta !== undefined ? { delta: d.delta } : {})}
      {...(d.deltaLabel ? { deltaLabel: d.deltaLabel } : {})}
      {...(panel.spark && d.spark ? { spark: d.spark } : {})}
      {...(panel.thresholds ? { thresholds: panel.thresholds } : {})}
      {...(panel.accent ? { accent: panel.accent } : {})}
    />
  );
}
case 'distribution': {
  const d = (data ?? {}) as { buckets?: { label: string; count: number }[]; p50?: number; p95?: number; p99?: number };
  return <DistributionChartCard title={panel.title} buckets={d.buckets ?? []}
    {...(d.p50 !== undefined ? { p50: d.p50 } : {})} {...(d.p95 !== undefined ? { p95: d.p95 } : {})} {...(d.p99 !== undefined ? { p99: d.p99 } : {})} />;
}
case 'gauge': {
  const d = (data ?? {}) as { value?: number; min?: number; max?: number };
  return <GaugeCard title={panel.title} value={d.value ?? 0} {...(panel.min !== undefined ? { min: panel.min } : {})} {...(panel.max !== undefined ? { max: panel.max } : {})} />;
}
case 'breakdown': {
  const d = (data ?? {}) as { segments?: { label: string; value: number; color?: string }[] };
  return <BreakdownCard title={panel.title} segments={d.segments ?? []} {...(panel.style ? { style: panel.style } : {})} />;
}
```

Add the imports for the three new cards at the top.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope-ui exec vitest run test/react/panel-renderer-new.spec.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write packages/ui/src/react/components/extensions/panel-renderer.tsx packages/ui/test/react/panel-renderer-new.spec.tsx
git add -A
git commit -m "feat(ui): render distribution/gauge/breakdown + enriched stat in PanelView

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Sectioned dashboard layout + LIVE indicator

**Files:**
- Modify: `packages/ui/src/app/pages/extension-dashboard-page.tsx`
- Test: `packages/ui/test/app/extension-dashboard-page.spec.tsx` (create or extend)

**Interfaces:**
- Consumes: `useTelescopeStream` (Task 5); `DashboardSpec.sections` (Task 2).
- Produces: when `dash.sections` is present, render each section (optional title + `cols`-column responsive grid); else fall back to the flat `panels` grid. Render a header with the dashboard label + a `● LIVE`/`reconnecting`/`polling` badge from `useTelescopeStream().status`.

- [ ] **Step 1: Write the failing test** — sections render with titles:

```typescript
// packages/ui/test/app/extension-dashboard-page.spec.tsx (key case)
// Mock useMeta to return a dashboard with two sections and assert both section
// titles render and panels are grouped. (Follow the existing page-test setup in
// the repo — QueryClientProvider + MemoryRouter + mocked useTelescopeClient.)
```

(Write the concrete test mirroring the existing `OverviewPage.spec.tsx`/`dashboard-layout.spec.tsx` harness: wrap in `QueryClientProvider` + `MemoryRouter initialEntries={['/ext/demo.page']}`, stub the client's `meta()` to return a dashboard with `sections: [{title:'Health',cols:4,panels:[...]},{title:'Trends',cols:2,panels:[...]}]`, assert `screen.getByText('Health')` and `screen.getByText('Trends')`.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope-ui exec vitest run test/app/extension-dashboard-page.spec.tsx`
Expected: FAIL — section titles not rendered (flat grid ignores `sections`).

- [ ] **Step 3: Implement** — update `ExtensionDashboardPage`:

```typescript
const colClass: Record<2 | 3 | 4, string> = {
  2: 'md:grid-cols-2',
  3: 'md:grid-cols-3',
  4: 'md:grid-cols-2 lg:grid-cols-4',
};

export function ExtensionDashboardPage(): JSX.Element {
  const { dashboardId } = useParams();
  const meta = useMeta();
  const { status } = useTelescopeStream();
  const dash = meta.data?.dashboards?.find((d) => d.id === dashboardId);
  if (!dash) return <div className="p-6 text-sm text-zinc-400">Dashboard not found.</div>;
  const ext = dashboardId?.split('.')[0] ?? '';
  const sections = dash.sections ?? [{ panels: dash.panels, cols: 2 as const }];
  return (
    <div className="p-4">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-sm font-semibold text-zinc-200">{dash.label}</h2>
        <LiveBadge status={status} />
      </div>
      {sections.map((section, i) => (
        <section key={section.title ?? `s${i}`} className="mb-6">
          {section.title && (
            <p className="text-[10px] uppercase tracking-wide text-zinc-500 mb-2">{section.title}</p>
          )}
          <div className={`grid grid-cols-1 gap-3 ${colClass[section.cols ?? 2]}`}>
            {section.panels.map((panel) => (
              <BoundPanel key={`${panel.kind}-${panel.title}`} ext={ext} panel={panel} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
```

Add a small `LiveBadge` component (green pulsing dot + "LIVE" when `status==='live'`, amber "reconnecting"/"polling" otherwise). Keep `BoundPanel` as-is.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope-ui exec vitest run test/app/extension-dashboard-page.spec.tsx`
Expected: PASS. Then build the UI: `pnpm --filter @dudousxd/nestjs-telescope-ui build`.

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write packages/ui/src/app/pages/extension-dashboard-page.tsx packages/ui/test/app/extension-dashboard-page.spec.tsx
git add -A
git commit -m "feat(ui): sectioned dashboard layout + LIVE (SSE) indicator

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Telescope changeset + green build

**Files:**
- Create: `.changeset/rich-dashboards.md`

- [ ] **Step 1: Write the changeset**

```markdown
---
'@dudousxd/nestjs-telescope': minor
---

Rich extension dashboards: the panel IR gains delta/sparkline/threshold on `stat`
and new `distribution`, `gauge`, and `breakdown` panel kinds, plus a `sections`
layout. Dashboards update in realtime over a new `@Sse` invalidation stream
(falling back to polling), with a LIVE indicator. Fully backward compatible —
existing extensions and flat `stat` panels render unchanged.
```

- [ ] **Step 2: Full build + test**

Run: `cd nestjs-telescope && pnpm -r build && pnpm -r test && pnpm typecheck && pnpm lint`
Expected: all green (core + ui suites incl. the new specs).

- [ ] **Step 3: Commit**

```bash
git add .changeset/rich-dashboards.md
git commit -m "chore: changeset for rich dashboards (telescope minor)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Durable watcher — persist `durationMs` (+ `attempts` if available)

**Files:**
- Modify: `nestjs-durable/packages/telescope/src/durable-telescope.watcher.ts`
- Test: `nestjs-durable/packages/telescope/src/durable-telescope.watcher.spec.ts` (extend)

**Interfaces:**
- Produces: the recorded `content` for run events additionally carries `durationMs?: number` (from `EngineEvent.durationMs`), enabling duration percentiles in the provider (Task 12). `attempts` is sourced from the store in Task 12, not here (the `EngineEvent` has no attempt count).

- [ ] **Step 1: Write the failing test** — a `run.completed` event with `durationMs` records it:

```typescript
// add to durable-telescope.watcher.spec.ts
it('records durationMs from run.completed events', () => {
  // arrange the fake engine to emit { type:'run.completed', runId:'r1', workflow:'W', durationMs: 1234, at: new Date() }
  // assert the captured ctx.record call's content.durationMs === 1234
});
```

(Mirror the existing watcher-spec harness that fakes `WorkflowEngine.subscribe` and captures `ctx.record`.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd nestjs-durable && pnpm --filter @dudousxd/nestjs-durable-telescope exec vitest run src/durable-telescope.watcher.spec.ts`
Expected: FAIL — `content.durationMs` is undefined.

- [ ] **Step 3: Implement** — in the `content` object built in `register()`, add `durationMs`:

```typescript
content: {
  event: event.type,
  workflow: event.workflow,
  runId: event.runId,
  seq: event.seq,
  name: event.name,
  kind: event.kind,
  output: event.output,
  error: event.error,
  durationMs: event.durationMs,
},
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-durable-telescope exec vitest run src/durable-telescope.watcher.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write packages/telescope/src
git add -A
git commit -m "feat(durable-telescope): persist run durationMs for percentile metrics

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Durable providers — percentiles, throughput, deltas, buckets, breakdown

**Files:**
- Modify: `nestjs-durable/packages/telescope/src/durable-data-providers.ts`
- Modify: `nestjs-durable/packages/telescope/src/durable-telescope.extension.ts` (register new providers)
- Test: `nestjs-durable/packages/telescope/src/durable-data-providers.spec.ts` (extend)

**Interfaces:**
- Produces new providers/metrics (all reading the bounded `durable` entry page or the state store):
  - `durable.successRate` → `{ value, delta?, spark? }` (current window vs previous equal window; spark = per-bucket success rate).
  - `durable.duration` → `{ buckets, p50, p95, p99 }` (from `content.durationMs` on `run.completed`).
  - `durable.throughput` → `{ value, delta?, spark? }` (completed/hour).
  - `durable.runsOverTime` → `{ rows: Array<{ label: string; done: number; failed: number }> }` (time-bucketed).
  - `durable.stateBreakdown` → `{ segments: Array<{ label: string; value: number; color? }> }` (from state store counts).
  - **`durable.retryHotspots`** → `{ items }` ONLY if the state store exposes step checkpoints with `attempts`; otherwise DO NOT add this provider (and Task 13 omits its panel).

- [ ] **Step 1: Write the failing tests** — percentile + bucketing from a fixture of entries:

```typescript
// durable-data-providers.spec.ts (key cases)
import { describe, expect, it } from 'vitest';
import { durableDurationProvider, durableRunsOverTimeProvider } from './durable-data-providers';

function ctxWith(entries: Array<{ content: unknown; createdAt: Date }>) {
  const storage = { get: async () => ({ data: entries }) };
  return { moduleRef: { get: () => storage }, config: {} } as never;
}

describe('durable.duration', () => {
  it('computes p50/p95/p99 from run.completed durationMs', async () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      content: { event: 'run.completed', durationMs: (i + 1) * 10 },
      createdAt: new Date(),
    }));
    const out = (await durableDurationProvider().resolve({}, ctxWith(entries))) as { p95: number; buckets: unknown[] };
    expect(out.p95).toBe(950);
    expect(out.buckets.length).toBeGreaterThan(0);
  });
});

describe('durable.runsOverTime', () => {
  it('buckets done vs failed by time', async () => {
    const t = new Date('2026-06-17T10:00:00Z');
    const entries = [
      { content: { event: 'run.completed' }, createdAt: t },
      { content: { event: 'run.failed', workflow: 'W' }, createdAt: t },
    ];
    const out = (await durableRunsOverTimeProvider().resolve({ buckets: 6 }, ctxWith(entries))) as { rows: Array<{ done: number; failed: number }> };
    const totals = out.rows.reduce((a, r) => ({ done: a.done + r.done, failed: a.failed + r.failed }), { done: 0, failed: 0 });
    expect(totals).toEqual({ done: 1, failed: 1 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-durable-telescope exec vitest run src/durable-data-providers.spec.ts`
Expected: FAIL — providers don't exist.

- [ ] **Step 3: Implement** — add the providers. Percentile helper + duration provider:

```typescript
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function durableDurationProvider(): DataProvider {
  return {
    name: 'durable.duration',
    async resolve(query, ctx: ExtensionContext) {
      const storage = ctx.moduleRef.get(TELESCOPE_STORAGE, { strict: false }) as {
        get(q: { type?: string; limit?: number }): Promise<{ data: Array<{ content?: unknown }> }>;
      };
      const page = await storage.get({ type: 'durable', limit: 5_000 });
      const durs: number[] = [];
      for (const e of page.data) {
        const c = (e.content ?? {}) as { event?: string; durationMs?: number };
        if (c.event === 'run.completed' && typeof c.durationMs === 'number') durs.push(c.durationMs);
      }
      durs.sort((a, b) => a - b);
      // 8 log-ish buckets between min and max
      const max = durs.at(-1) ?? 0;
      const bucketCount = 8;
      const size = Math.max(1, Math.ceil((max + 1) / bucketCount));
      const buckets = Array.from({ length: bucketCount }, (_, i) => ({
        label: `${Math.round((i * size) / 100) / 10}s`,
        count: 0,
      }));
      for (const d of durs) buckets[Math.min(bucketCount - 1, Math.floor(d / size))].count += 1;
      return { buckets, p50: percentile(durs, 50), p95: percentile(durs, 95), p99: percentile(durs, 99) };
    },
  };
}
```

Add `durableRunsOverTimeProvider` (bucket `run.completed`→`done`, `run.failed`→`failed` by `createdAt` into N=`query.buckets ?? 24` time buckets, return `{ rows }`), `durableSuccessRateProvider` and `durableThroughputProvider` (two-window delta + per-bucket spark from the same entry page), and `durableStateBreakdownProvider` (state store counts for running/pending/completed/failed/dead → `{ segments }` with the standard palette). For **retryHotspots**, first check whether `STATE_STORE` exposes a way to list step checkpoints with `attempts`; if it does, add `durableRetryHotspotsProvider` returning `{ items: topN steps by attempts-1 }`; if not, skip it and note in the commit message.

Register the new providers in `durable-telescope.extension.ts`'s `dataProviders` array.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-durable-telescope exec vitest run src/durable-data-providers.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write packages/telescope/src
git add -A
git commit -m "feat(durable-telescope): percentile/throughput/delta/bucket/breakdown providers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Redesign the durable Workflows dashboard (sections + golden signals)

**Files:**
- Modify: `nestjs-durable/packages/telescope/src/durable-dashboard.spec-data.ts`
- Modify: `nestjs-durable/packages/telescope/src/durable-dashboard.spec-data.spec.ts` (the existing spec-data test, if present) or create one
- Create: `.changeset/rich-workflows-dashboard.md`

**Interfaces:**
- Consumes: providers from Task 12; the IR from Tasks 1–2 (consumed via the published/locally-linked telescope minor).
- Produces: `durableDashboard(opts)` returning a `DashboardSpec` with `sections` (Health / Needs attention / Trends).

- [ ] **Step 1: Write the failing test** — assert the new structure:

```typescript
// durable-dashboard.spec-data.spec.ts
import { describe, expect, it } from 'vitest';
import { durableDashboard } from './durable-dashboard.spec-data';

describe('durableDashboard', () => {
  it('is sectioned with a health row and a trends section', () => {
    const d = durableDashboard({ runHref: '/durable/runs/{runId}' });
    expect(d.sections?.[0].title).toMatch(/health/i);
    const kinds = d.sections?.flatMap((s) => s.panels.map((p) => p.kind)) ?? [];
    expect(kinds).toContain('distribution');
    expect(kinds).toContain('breakdown');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-durable-telescope exec vitest run src/durable-dashboard.spec-data.spec.ts`
Expected: FAIL — `sections` undefined.

- [ ] **Step 3: Implement** — rewrite `durableDashboard` to return `sections` (keep `panels: []` for the type's back-compat field):

```typescript
return {
  id: 'durable.workflows',
  label: 'Workflows',
  panels: [],
  sections: [
    {
      title: 'Health',
      cols: 4,
      panels: [
        { kind: 'gauge', title: 'Success rate', data: { provider: 'durable.successRate' }, max: 1, format: 'percent',
          thresholds: { warn: 0.98, bad: 0.95, direction: 'down-bad' } },
        { kind: 'stat', title: 'Duration p95', data: { provider: 'durable.duration', query: { metric: 'p95' } }, format: 'duration', spark: false,
          thresholds: { warn: 2000, bad: 5000, direction: 'up-bad' } },
        { kind: 'stat', title: 'Backlog', data: { provider: 'durable.state', query: { status: 'pending' } }, spark: false,
          thresholds: { warn: 50, bad: 200, direction: 'up-bad' } },
        { kind: 'stat', title: 'Throughput', data: { provider: 'durable.throughput' }, format: 'rate', spark: true },
      ],
    },
    {
      title: 'Needs attention',
      cols: 3,
      panels: [
        { kind: 'topN', title: 'Top failing workflows', data: { provider: 'durable.timeseries', query: { metric: 'topFailures' } }, limit: 8 },
        { kind: 'table', title: 'Stuck runs', data: { provider: 'durable.recentFailures', query: { windowMs } },
          columns: [
            { key: 'updatedAt', label: 'Updated' },
            { key: 'workflow', label: 'Workflow' },
            { key: 'runId', label: 'Run', link: { href: runHref } },
            { key: 'error', label: 'Error' },
          ] },
        { kind: 'table', title: 'Starved worker groups', data: { provider: 'durable.workerHealth' },
          columns: [
            { key: 'group', label: 'Group' }, { key: 'queued', label: 'Queued' },
            { key: 'liveWorkers', label: 'Workers' }, { key: 'status', label: 'Status' },
          ] },
      ],
    },
    {
      title: 'Trends',
      cols: 3,
      panels: [
        { kind: 'timeseries', title: 'Runs over time', data: { provider: 'durable.runsOverTime' }, series: ['done', 'failed'], style: 'stacked' },
        { kind: 'distribution', title: 'Duration distribution', data: { provider: 'durable.duration' }, markers: ['p50', 'p95', 'p99'], format: 'duration' },
        { kind: 'breakdown', title: 'Runs by state', data: { provider: 'durable.stateBreakdown' }, style: 'donut' },
      ],
    },
  ],
};
```

If `durable.retryHotspots` was added in Task 12, insert a `topN` "Steps with most retries" panel into "Needs attention"; otherwise leave it out. Make `durable.duration` accept `query.metric === 'p95'` → return `{ value: p95 }` (a stat) in addition to the full distribution shape (no query → distribution).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-durable-telescope exec vitest run` (the whole package) + `pnpm -r build` + `pnpm typecheck` + `pnpm lint`.
Expected: all green.

- [ ] **Step 5: Commit + changeset**

```markdown
// .changeset/rich-workflows-dashboard.md
---
'@dudousxd/nestjs-durable-telescope': minor
---

Redesign the Workflows dashboard as golden-signals sections (Health / Needs
attention / Trends): success-rate gauge, p95 duration + distribution, backlog and
throughput with trend, top failing workflows, stuck runs, and a state breakdown.
Requires `@dudousxd/nestjs-telescope` with the enriched panel IR.
```

```bash
pnpm exec biome check --write packages/telescope/src
git add -A
git commit -m "feat(durable-telescope): golden-signals Workflows dashboard redesign

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: Cross-repo integration check + dev verification

**Files:** none (verification only)

- [ ] **Step 1:** Build telescope core+ui, rsync `dist/` into durable's linked telescope (per `pnpm-file-dep-stale-hardlink` pattern) OR bump durable's telescope devDep to the new local version, so durable consumes the new IR.

```bash
cd nestjs-telescope && pnpm -r build
# rsync core+ui dist into durable's .pnpm/@dudousxd+nestjs-telescope@*/.../dist (see memory pnpm-file-dep-stale-hardlink)
```

- [ ] **Step 2:** Run durable telescope package tests against the new IR.

Run: `cd nestjs-durable && pnpm --filter @dudousxd/nestjs-durable-telescope test`
Expected: green.

- [ ] **Step 3:** Manual smoke (optional, document in the PR): run an app with both modules, open `/telescope` → Workflows tab, confirm the sectioned layout renders, panels resolve, and the ● LIVE badge shows; trigger a workflow and confirm panels update without a manual refresh (SSE).

- [ ] **Step 4:** No commit (verification). Open the two PRs (`spec/telescope-rich-dashboards` → telescope `main`; durable feature branch → durable `main`). Telescope publishes first; durable's changeset version PR merges after the telescope minor is on npm.

---

## Self-Review

**Spec coverage:**
- Panel IR additions (§4) → Tasks 1–2, 6–8. ✓
- SSE realtime (§5) → Tasks 3–5, 9. ✓
- Workflows metric set (§6) → Tasks 11–13. ✓ (retry-hotspots conditional, per §9 risk — Tasks 12/13 gate it.)
- Rendering/layout (§7) → Tasks 6–9. ✓
- Providers (§5/§6) → Task 12. ✓
- Testing (§8) → every task is TDD; provider/IR/SSE/render covered. ✓
- Rollout/changesets (§10) → Tasks 10, 13. ✓
- Out of scope (§11): authz/inertia NOT in this plan. ✓

**Placeholder scan:** Task 9's step-1 and Task 12's secondary providers describe code via prose + partial snippets rather than full literal blocks (they follow an existing in-repo harness/pattern). These are intentional "follow the established pattern" references to existing test/provider scaffolding, with the exact shapes and key bodies given. Acceptable for an implementer reading neighboring files; the novel logic (percentiles, bucketing, IR types, SSE, StatCard, dashboard spec) is fully literal.

**Type consistency:** Provider return shapes (`{value,delta?,spark?}`, `{buckets,p50,p95,p99}`, `{segments}`) match StatCard/DistributionChartCard/BreakdownCard props and the PanelView cases. `PanelThresholds` is identical in core (Task 1), ui types (Task 2), and StatCard (Task 6). Query keys `['telescope','ext-data',...]`/`['telescope','meta']` match between `use-telescope-queries.ts` and the SSE hook (Task 5). `durable.duration` serves both distribution (no query) and stat `p95` (Task 12 ↔ Task 13).
