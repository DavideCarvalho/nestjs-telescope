# Time-Series + Sparkline Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add throughput time-series to the headless API (`GET /telescope/api/timeseries`) — bucketed counts over a window, computed from stored entries — and render it as a sparkline/area chart in the dashboard. Polling stays.

**Architecture:** Consistent with queue metrics / pulse: aggregate FROM stored entries on demand via the shared `collectEntriesInWindow`, reduced by a pure `bucketTimeseries` into per-time-bucket counts (total + per type). No new capture mechanism. The chart is a zero-dependency custom SVG `Sparkline` (lean, fits the dark console) — no charting lib. A `useTimeseries(window)` hook (polling `refetchInterval`) feeds it.

**Tech Stack:** TypeScript (ESM/NodeNext, strict), NestJS 11, React 18 + TanStack Query 5, vitest, biome, pnpm+turbo, changesets. Core + UI packages.

---

## Task 1: Pure `bucketTimeseries` reducer (core)

**Files:** `packages/core/src/metrics/timeseries.ts`, test `packages/core/src/metrics/timeseries.spec.ts`.

- [ ] **Step 1: Write the failing test** — `timeseries.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { bucketTimeseries } from './timeseries.js';

function entry(type: string, createdAt: Date): Entry {
  return {
    id: `${type}-${Math.random()}`, batchId: 'b', type, familyHash: null, content: {},
    tags: [], sequence: 0, durationMs: null, origin: 'http', instanceId: 'i', createdAt,
  };
}

const start = new Date('2026-06-02T11:00:00Z');
const end = new Date('2026-06-02T12:00:00Z'); // 60-minute window

describe('bucketTimeseries', () => {
  it('buckets entries into N equal time buckets with total + byType', () => {
    const report = bucketTimeseries(
      [
        entry('request', new Date('2026-06-02T11:00:30Z')), // bucket 0
        entry('query', new Date('2026-06-02T11:00:45Z')), // bucket 0
        entry('request', new Date('2026-06-02T11:30:00Z')), // bucket 30
        entry('job', new Date('2026-06-02T11:59:59Z')), // bucket 59
      ],
      start,
      end,
      60, // 60 buckets => 1 minute each
    );
    expect(report.buckets).toHaveLength(60);
    expect(report.bucketMs).toBe(60_000);
    expect(report.buckets[0]).toMatchObject({ total: 2, byType: { request: 1, query: 1 } });
    expect(report.buckets[30]).toMatchObject({ total: 1, byType: { request: 1 } });
    expect(report.buckets[59]).toMatchObject({ total: 1, byType: { job: 1 } });
    expect(report.buckets[1]!.total).toBe(0);
    expect(report.buckets[0]!.t).toBe('2026-06-02T11:00:00.000Z');
  });

  it('clamps out-of-window entries into the edge buckets and ignores nothing it is given', () => {
    const report = bucketTimeseries([entry('request', end)], start, end, 10);
    // an entry exactly at windowEnd lands in the last bucket (clamped)
    expect(report.buckets[9]!.total).toBe(1);
  });

  it('handles an empty input and a zero-length window without dividing by zero', () => {
    expect(bucketTimeseries([], start, end, 10).buckets).toHaveLength(10);
    const zero = bucketTimeseries([], start, start, 10);
    expect(zero.buckets).toHaveLength(10);
    expect(zero.bucketMs).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement `packages/core/src/metrics/timeseries.ts`:**

```ts
// packages/core/src/metrics/timeseries.ts
import type { Entry } from '../entry/entry.js';

export interface TimeseriesBucket {
  /** ISO timestamp of the bucket's start. */
  t: string;
  total: number;
  byType: Record<string, number>;
}

export interface TimeseriesReport {
  windowStart: string;
  windowEnd: string;
  bucketMs: number;
  buckets: TimeseriesBucket[];
}

/** Group entries into `bucketCount` equal time buckets across [windowStart,
 *  windowEnd], counting total + per-type per bucket. Pure: callers fetch the
 *  windowed entries. Out-of-range entries are clamped into the edge buckets. */
export function bucketTimeseries(
  entries: Entry[],
  windowStart: Date,
  windowEnd: Date,
  bucketCount: number,
): TimeseriesReport {
  const count = Math.max(1, Math.floor(bucketCount));
  const startMs = windowStart.getTime();
  const spanMs = Math.max(1, windowEnd.getTime() - startMs);
  const bucketMs = Math.max(1, Math.floor(spanMs / count));

  const buckets: TimeseriesBucket[] = Array.from({ length: count }, (_, index) => ({
    t: new Date(startMs + index * bucketMs).toISOString(),
    total: 0,
    byType: {},
  }));

  for (const entry of entries) {
    const offset = entry.createdAt.getTime() - startMs;
    const rawIndex = Math.floor(offset / bucketMs);
    const index = Math.min(count - 1, Math.max(0, rawIndex));
    const bucket = buckets[index];
    if (!bucket) continue;
    bucket.total += 1;
    bucket.byType[entry.type] = (bucket.byType[entry.type] ?? 0) + 1;
  }

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    bucketMs,
    buckets,
  };
}
```

- [ ] **Step 4: Run, verify PASS + typecheck + lint.**

- [ ] **Step 5: Commit**
```bash
git add packages/core/src/metrics/timeseries.ts packages/core/src/metrics/timeseries.spec.ts
git commit -m "feat(core): add pure bucketTimeseries reducer (throughput over time)"
```

---

## Task 2: `TimeseriesService` + `/timeseries` endpoint (core)

**Files:** `packages/core/src/metrics/timeseries.service.ts`, modify `telescope.module.ts` (register), `telescope.controller.ts` (endpoint), `index.ts` (export); tests `timeseries.service.spec.ts` + extend the controller test or add `telescope.controller.timeseries.spec.ts`.

- [ ] **Step 1: Write the failing service test** — `timeseries.service.spec.ts`:

```ts
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TimeseriesService } from './timeseries.service.js';

function entry(type: string, createdAt: Date): Entry {
  return {
    id: `${type}-${Math.random()}`, batchId: 'b', type, familyHash: null, content: {},
    tags: type === 'job' ? ['queue:mail'] : [], sequence: 0, durationMs: null,
    origin: 'http', instanceId: 'i', createdAt,
  };
}

describe('TimeseriesService', () => {
  it('buckets windowed entries from storage', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    await storage.store([
      entry('request', new Date(now - 60_000)),
      entry('query', new Date(now - 50_000)),
      entry('request', new Date(now - 600_000)), // outside a 5m window
    ]);
    const service = new TimeseriesService(storage);
    const report = await service.getTimeseries({ windowMs: 300_000, buckets: 5 });
    const total = report.buckets.reduce((sum, b) => sum + b.total, 0);
    expect(total).toBe(2); // the 10m-old one excluded
    expect(report.scanned).toBe(2);
    expect(report.buckets).toHaveLength(5);
  });

  it('applies a tag filter (per-queue series)', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    await storage.store([entry('job', new Date(now - 1000)), entry('request', new Date(now - 1000))]);
    const service = new TimeseriesService(storage);
    const report = await service.getTimeseries({ windowMs: 300_000, buckets: 5, tag: 'queue:mail' });
    expect(report.scanned).toBe(1);
  });

  it('rejects a non-positive window', async () => {
    const service = new TimeseriesService(new InMemoryStorageProvider());
    await expect(service.getTimeseries({ windowMs: 0, buckets: 5 })).rejects.toBeInstanceOf(RangeError);
  });
});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement `packages/core/src/metrics/timeseries.service.ts`:**

```ts
// packages/core/src/metrics/timeseries.service.ts
import { Inject, Injectable, Optional } from '@nestjs/common';
import { TELESCOPE_STORAGE } from '../nest/telescope.options.js';
import type { EntryQuery, StorageProvider } from '../storage/storage-provider.js';
import { collectEntriesInWindow } from './collect-window.js';
import { type TimeseriesReport, bucketTimeseries } from './timeseries.js';

/** Default + max buckets per request. */
const DEFAULT_BUCKETS = 60;
const MAX_BUCKETS = 500;

export interface TimeseriesQuery {
  windowMs: number;
  buckets?: number;
  type?: string;
  tag?: string;
}

export interface TimeseriesServiceOptions {
  pageSize?: number;
  scanCap?: number;
}

export interface TimeseriesResult extends TimeseriesReport {
  scanned: number;
  truncated: boolean;
}

/** Computes a throughput time-series by aggregating stored entries over a
 *  window. Reads the store on demand — no separate time-series capture. */
@Injectable()
export class TimeseriesService {
  private readonly pageSize: number | undefined;
  private readonly scanCap: number | undefined;

  constructor(
    @Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider,
    @Optional() options?: TimeseriesServiceOptions,
  ) {
    this.pageSize = options?.pageSize;
    this.scanCap = options?.scanCap;
  }

  async getTimeseries(query: TimeseriesQuery): Promise<TimeseriesResult> {
    if (!Number.isFinite(query.windowMs) || query.windowMs <= 0) {
      throw new RangeError(`windowMs must be a positive, finite number (got ${query.windowMs}).`);
    }
    const buckets = Math.min(MAX_BUCKETS, Math.max(1, Math.floor(query.buckets ?? DEFAULT_BUCKETS)));
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - query.windowMs);

    const baseQuery: Omit<EntryQuery, 'cursor' | 'limit'> = {
      after: windowStart,
      ...(query.type !== undefined ? { type: query.type } : {}),
      ...(query.tag !== undefined ? { tag: query.tag } : {}),
    };
    const { entries, scanned, truncated } = await collectEntriesInWindow(this.storage, baseQuery, {
      ...(this.pageSize !== undefined ? { pageSize: this.pageSize } : {}),
      ...(this.scanCap !== undefined ? { scanCap: this.scanCap } : {}),
    });

    const report = bucketTimeseries(entries, windowStart, windowEnd, buckets);
    return { ...report, scanned, truncated };
  }
}
```

- [ ] **Step 4: Register + export.** In `telescope.module.ts` add `TimeseriesService` to `SHARED_PROVIDERS` and to both `exports` arrays. In `index.ts` add `export * from './metrics/timeseries.js';` and `export * from './metrics/timeseries.service.js';`.

- [ ] **Step 5: Endpoint.** In `telescope.controller.ts`, inject `TimeseriesService` and add (reuse the existing `durationToMs` + `BadRequestException`):
```ts
  @Get('timeseries')
  timeseries(
    @Query('window') window?: string,
    @Query('buckets') buckets?: string,
    @Query('type') type?: string,
    @Query('tag') tag?: string,
  ): Promise<TimeseriesResult> {
    let windowMs: number;
    try {
      windowMs = durationToMs(window ?? '1h');
    } catch {
      throw new BadRequestException(`Invalid window: ${window}`);
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new BadRequestException(`Window must be positive: ${window}`);
    }
    const bucketCount = buckets !== undefined ? Number(buckets) : undefined;
    return this.timeseriesService.getTimeseries({
      windowMs,
      ...(bucketCount !== undefined && Number.isFinite(bucketCount) ? { buckets: bucketCount } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(tag !== undefined ? { tag } : {}),
    });
  }
```
Add the constructor param `@Inject(TimeseriesService) private readonly timeseriesService: TimeseriesService` and the imports (`TimeseriesService`, `type TimeseriesResult` from `../metrics/timeseries.service.js`).

- [ ] **Step 6: Add a controller endpoint test** `packages/core/src/nest/telescope.controller.timeseries.spec.ts` (mirror the pulse controller spec: boot `TelescopeModule.forRoot({ enabled, authorizer: () => true, storage })` with a few stored entries; `GET /telescope/api/timeseries?window=1h&buckets=12` → 200 with `buckets.length === 12`; `?window=soon` → 400).

- [ ] **Step 7: Verify** — service test, controller test, full core suite, typecheck, lint all green.

- [ ] **Step 8: Commit**
```bash
git add packages/core/src/metrics/timeseries.service.ts packages/core/src/nest/telescope.module.ts packages/core/src/nest/telescope.controller.ts packages/core/src/index.ts packages/core/src/metrics/timeseries.service.spec.ts packages/core/src/nest/telescope.controller.timeseries.spec.ts
git commit -m "feat(core): add TimeseriesService + GET /telescope/api/timeseries"
```

---

## Task 3: UI client `timeseries()` + types

**Files:** modify `packages/ui/src/client/types.ts`, `telescope-client.ts`; update `telescope-client.spec.ts`.

- [ ] **Step 1: Add types** to `types.ts`:
```ts
export interface TimeseriesBucket { t: string; total: number; byType: Record<string, number>; }
export interface TimeseriesReport {
  windowStart: string;
  windowEnd: string;
  bucketMs: number;
  buckets: TimeseriesBucket[];
  scanned: number;
  truncated: boolean;
}
export interface TimeseriesQuery { window?: string; buckets?: number; type?: string; tag?: string; }
```

- [ ] **Step 2: Add the client method** in `telescope-client.ts` — extend the `TelescopeClient` interface with `timeseries(query?: TimeseriesQuery): Promise<TimeseriesReport>` and implement:
```ts
    timeseries: (query = {}) =>
      get<TimeseriesReport>('/timeseries', {
        window: query.window,
        buckets: query.buckets,
        type: query.type,
        tag: query.tag,
      }),
```
Import the new types. (The `get` helper already skips `undefined` params and `String()`-ifies numbers, so `buckets` works.)

- [ ] **Step 3: Add a client test** in `telescope-client.spec.ts`:
```ts
  it('fetches timeseries with window + buckets', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ buckets: [] }) }) as Response);
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await client.timeseries({ window: '1h', buckets: 60 });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/timeseries?');
    expect(url).toContain('window=1h');
    expect(url).toContain('buckets=60');
  });
```

- [ ] **Step 4: Verify + commit**
```bash
git add packages/ui/src/client
git commit -m "feat(ui): add timeseries() to the typed client"
```

---

## Task 4: `Sparkline` SVG component + `useTimeseries` hook (UI `/react`)

**Files:** `packages/ui/src/react/components/sparkline.tsx`, update `use-telescope-queries.ts` + `index.ts`; test `components/sparkline.spec.tsx`.

- [ ] **Step 1: `components/sparkline.tsx`** — zero-dep SVG area+line; export the pure point math for testing:
```tsx
export function sparklinePoints(values: number[], width: number, height: number): string {
  if (values.length === 0) return '';
  const max = Math.max(...values, 1);
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  return values
    .map((value, index) => {
      const x = index * stepX;
      const y = height - (value / max) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

export function Sparkline({
  values,
  width = 160,
  height = 36,
}: { values: number[]; width?: number; height?: number }): JSX.Element {
  const points = sparklinePoints(values, width, height);
  const area = points ? `0,${height} ${points} ${width},${height}` : '';
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="throughput">
      {area && <polygon points={area} className="fill-emerald-500/10" />}
      {points && <polyline points={points} className="fill-none stroke-emerald-400" strokeWidth={1.5} />}
    </svg>
  );
}
```

- [ ] **Step 2: `useTimeseries` hook** — add to `use-telescope-queries.ts`:
```ts
export function timeseriesQuery(client: TelescopeClient, query: { window: string; buckets?: number; type?: string; tag?: string }) {
  return queryOptions({
    queryKey: ['telescope', 'timeseries', query],
    queryFn: () => client.timeseries(query),
    refetchInterval: REFETCH_MS,
  });
}
export function useTimeseries(query: { window: string; buckets?: number; type?: string; tag?: string }) {
  return useQuery(timeseriesQuery(useTelescopeClient(), query));
}
```

- [ ] **Step 3: Export** `Sparkline`/`sparklinePoints` from `react/index.ts` (add `export * from './components/sparkline.js';`).

- [ ] **Step 4: Test** `components/sparkline.spec.tsx`:
```tsx
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Sparkline, sparklinePoints } from './sparkline.js';

describe('sparklinePoints', () => {
  it('maps values to scaled points (max at top, zero at bottom)', () => {
    // values [0, 10] over width 10, height 10 => (0,10) then (10,0)
    expect(sparklinePoints([0, 10], 10, 10)).toBe('0.0,10.0 10.0,0.0');
  });
  it('returns empty for no values', () => {
    expect(sparklinePoints([], 10, 10)).toBe('');
  });
});

describe('Sparkline', () => {
  it('renders an svg', () => {
    const { container } = render(<Sparkline values={[1, 2, 3]} />);
    expect(container.querySelector('svg')).toBeTruthy();
    expect(container.querySelector('polyline')).toBeTruthy();
  });
});
```

- [ ] **Step 5: Verify + commit**
```bash
git add packages/ui/src/react
git commit -m "feat(ui): zero-dep Sparkline component + useTimeseries hook"
```

---

## Task 5: Wire the throughput chart into the dashboard

**Files:** modify `packages/ui/src/app/pages/pulse-page.tsx` (add a throughput sparkline header). Optionally add a thin throughput strip to `dashboard-layout.tsx` — keep to the Pulse page for v1.

- [ ] **Step 1:** In `pulse-page.tsx`, add `useTimeseries({ window, buckets: 60 })` and render a `<Sparkline values={...}>` above the `PulsePanel`, mapping `data.buckets.map((b) => b.total)`. Label it "Throughput". Example:
```tsx
import { PulsePanel, Sparkline, WindowSelect, usePulse, useTimeseries } from '../../react/index.js';
// inside the component, after usePulse:
  const series = useTimeseries({ window, buckets: 60 });
  // ...in the JSX, between the header and PulsePanel:
        <div className="mb-6">
          <p className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Throughput</p>
          <Sparkline values={(series.data?.buckets ?? []).map((bucket) => bucket.total)} width={640} height={48} />
        </div>
```
(`window` is the page's existing window state, so the sparkline follows the selector.)

- [ ] **Step 2: Build + verify** — `pnpm --filter @dudousxd/nestjs-telescope-ui build`; confirm `dist/spa` regenerates; `... typecheck`, `pnpm lint`, `pnpm --filter @dudousxd/nestjs-telescope-ui test` (existing green).

- [ ] **Step 3: Commit**
```bash
git add packages/ui/src/app
git commit -m "feat(ui): throughput sparkline on the Pulse page"
```

---

## Task 6: Docs + changeset + whole-repo verify

- [ ] **Step 1: Root `README.md`** — add a line near the pulse/queues endpoints: "`GET /telescope/api/timeseries?window=1h&buckets=60` returns bucketed throughput (total + per type) for charts."

- [ ] **Step 2: Changeset** `.changeset/timeseries-charts.md`:
```markdown
---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
---

Add throughput time-series. `GET /telescope/api/timeseries?window=1h&buckets=60`
returns bucketed entry counts (total + per type) computed from stored entries
(`TimeseriesService` + `bucketTimeseries`), with optional `type`/`tag` filters.
The dashboard renders it as a zero-dependency SVG `Sparkline` on the Pulse page
(also exported at `/react`).
```

- [ ] **Step 3: Whole-repo `pnpm build && pnpm test && pnpm lint`** — all green. Report numbers.

- [ ] **Step 4: Commit**
```bash
git add README.md .changeset/timeseries-charts.md
git commit -m "docs: document timeseries endpoint + sparkline, add changeset"
```

---

## Self-Review

**Spec coverage:** time-series endpoint computed from storage (Tasks 1–2), typed client (Task 3), zero-dep Sparkline + hook (Task 4), wired into the dashboard (Task 5). Polling retained (the hook uses `refetchInterval`). Per-queue/per-type multi-series charts and richer chart types (stacked area, axes/tooltips) are intentionally out of scope (the endpoint already returns `byType` + accepts `type`/`tag` filters, so they're additive later) — noted, not stubbed.

**Placeholder scan:** No TBDs; complete code on the testable parts (reducer, service, client, sparkline math). The chart is a custom SVG (no chart-lib dep), keeping the bundle lean and the dark aesthetic.

**Type consistency:** `TimeseriesReport`/`TimeseriesBucket` defined in core (`metrics/timeseries.ts`), returned by `TimeseriesService.getTimeseries({ windowMs, buckets?, type?, tag? })` and the `/timeseries` endpoint; mirrored structurally in the UI client (`src/client/types.ts`) and consumed by `useTimeseries` + `Sparkline`. `bucketTimeseries(entries, start, end, bucketCount)` is the shared pure reducer; the service reuses `collectEntriesInWindow` (same windowed read as queue-metrics/pulse). `sparklinePoints` is the pure, tested math behind `Sparkline`.

**Risk note:** out-of-window clamping (an entry exactly at `windowEnd` lands in the last bucket) is intentional and tested; `bucketMs`/`spanMs` are floored at 1 to avoid divide-by-zero on a zero-length window; `buckets` is clamped to `[1, 500]` server-side to bound work and payload.
