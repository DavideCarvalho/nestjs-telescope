# Multi-Series Charts (per-type stacked + per-queue sparkline) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich the dashboard charts: a **per-type stacked bar** throughput chart on the Pulse page (from the timeseries `byType`), and a **per-queue sparkline** column on the Queues page (each queue's throughput via a `tag`-filtered timeseries). Purely additive — the `/telescope/api/timeseries` endpoint already returns `byType` and accepts `type`/`tag` filters. Zero-dependency SVG.

**Architecture:** All in the UI package's `/react` layer + app. A pure `stackedBarLayout` computes per-bucket per-type rects (testable); `<StackedBars>` renders them with a per-type color map. `<QueueSparkline queue window>` calls `useTimeseries({ tag: 'queue:<name>' })` and renders the existing `<Sparkline>`. `QueuesPanel` gains an optional `sparkline` render-prop so it stays presentational/composable. Polling stays.

**Tech Stack:** React 18, TanStack Query 5, Tailwind, vitest, biome.

---

## Task 1: `/react` — stacked bars + per-queue sparkline + QueuesPanel prop

**Files:** `packages/ui/src/react/components/stacked-bars.tsx`, `components/queue-sparkline.tsx`; modify `components/queues-panel.tsx` (add optional `sparkline` prop) + `index.ts`; test `components/stacked-bars.spec.tsx`.

- [ ] **Step 1: `components/stacked-bars.tsx`** — pure layout + color map + component:
```tsx
import type { TimeseriesBucket } from '../../client/index.js';

/** Tailwind `fill-*` classes per known entry type (extras fall back). */
export const TYPE_COLOR: Record<string, string> = {
  request: 'fill-emerald-400',
  query: 'fill-sky-400',
  job: 'fill-violet-400',
  exception: 'fill-red-400',
  http_client: 'fill-amber-400',
  mail: 'fill-pink-400',
};
const FALLBACK_COLOR = 'fill-zinc-500';

export function colorForType(type: string): string {
  return TYPE_COLOR[type] ?? FALLBACK_COLOR;
}

/** Ordered union of types present across buckets (known order first, then extras). */
export function deriveTypes(buckets: TimeseriesBucket[]): string[] {
  const seen = new Set<string>();
  for (const bucket of buckets) {
    for (const type of Object.keys(bucket.byType)) seen.add(type);
  }
  const known = Object.keys(TYPE_COLOR).filter((type) => seen.has(type));
  const extras = [...seen].filter((type) => !(type in TYPE_COLOR)).sort();
  return [...known, ...extras];
}

export interface BarSegment {
  x: number;
  y: number;
  width: number;
  height: number;
  type: string;
}

/** Compute stacked rects (bottom-up) for each bucket × type. Pure + testable. */
export function stackedBarLayout(
  buckets: TimeseriesBucket[],
  types: string[],
  width: number,
  height: number,
): BarSegment[] {
  if (buckets.length === 0) return [];
  const maxTotal = Math.max(1, ...buckets.map((bucket) => bucket.total));
  const barWidth = width / buckets.length;
  const segments: BarSegment[] = [];
  buckets.forEach((bucket, index) => {
    let yCursor = height;
    for (const type of types) {
      const value = bucket.byType[type] ?? 0;
      if (value === 0) continue;
      const segHeight = (value / maxTotal) * height;
      yCursor -= segHeight;
      segments.push({ x: index * barWidth, y: yCursor, width: barWidth, height: segHeight, type });
    }
  });
  return segments;
}

export function StackedBars({
  buckets,
  width = 640,
  height = 48,
}: { buckets: TimeseriesBucket[]; width?: number; height?: number }): JSX.Element {
  const types = deriveTypes(buckets);
  const segments = stackedBarLayout(buckets, types, width, height);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="throughput by type">
      {segments.map((segment, index) => (
        <rect
          // eslint-disable-next-line react/no-array-index-key -- segments are positional, no stable id
          key={`${segment.type}-${segment.x}-${index}`}
          x={segment.x}
          y={segment.y}
          width={Math.max(0, segment.width - 0.5)}
          height={segment.height}
          className={colorForType(segment.type)}
        />
      ))}
    </svg>
  );
}
```
> If biome flags the array-index key, use the composite key shown (`type-x-index`) which is sufficiently stable for positional bars; remove the eslint comment (biome, not eslint). If biome still complains, suppress with a `// biome-ignore lint/suspicious/noArrayIndexKey: positional chart segments` comment on the key line.

- [ ] **Step 2: `components/queue-sparkline.tsx`**:
```tsx
import { Sparkline } from './sparkline.js';
import { useTimeseries } from '../use-telescope-queries.js';

export function QueueSparkline({ queue, window }: { queue: string; window: string }): JSX.Element {
  const { data } = useTimeseries({ window, tag: `queue:${queue}`, buckets: 24 });
  return <Sparkline values={(data?.buckets ?? []).map((bucket) => bucket.total)} width={120} height={20} />;
}
```

- [ ] **Step 3: QueuesPanel optional `sparkline` prop.** In `components/queues-panel.tsx`, add an optional render-prop and a "Trend" column. Change the signature to:
```tsx
export function QueuesPanel({
  report,
  sparkline,
}: {
  report: QueueMetricsReport;
  sparkline?: (queue: string) => React.ReactNode;
}): JSX.Element {
```
Add a `<th className="font-normal">Trend</th>` at the end of the header row, and in each body row add a trailing cell:
```tsx
            {sparkline && <td className="text-zinc-400">{sparkline(q.queue)}</td>}
```
Also bump the empty-state `colSpan` from 7 to 8 (the new column). The `sparkline` prop is optional, so existing usages without it still render (the header gains a "Trend" column with empty cells — acceptable; or only render the `<th>` when `sparkline` is provided: `{sparkline && <th className="font-normal">Trend</th>}` — DO THIS so the column only appears when used, and keep the empty-state colSpan at 7 when no sparkline, 8 when present: use `colSpan={sparkline ? 8 : 7}`).

- [ ] **Step 4: Export** — add to `index.ts`:
```ts
export * from './components/stacked-bars.js';
export * from './components/queue-sparkline.js';
```

- [ ] **Step 5: Test** `components/stacked-bars.spec.tsx`:
```tsx
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TimeseriesBucket } from '../../client/index.js';
import { StackedBars, deriveTypes, stackedBarLayout } from './stacked-bars.js';

const buckets: TimeseriesBucket[] = [
  { t: '', total: 3, byType: { request: 2, query: 1 } },
  { t: '', total: 0, byType: {} },
  { t: '', total: 2, byType: { query: 2 } },
];

describe('deriveTypes', () => {
  it('returns known types first, present-only', () => {
    expect(deriveTypes(buckets)).toEqual(['request', 'query']);
  });
});

describe('stackedBarLayout', () => {
  it('stacks segments bottom-up scaled to the max bucket total', () => {
    // maxTotal = 3, height 30 => unit 10px/count. Bucket 0: query(1)=10 on top, request(2)=20 below.
    const segments = stackedBarLayout(buckets, ['request', 'query'], 30, 30);
    // bucket 0 has 2 segments; empty bucket 1 has none; bucket 2 has 1
    expect(segments.filter((s) => s.x === 0)).toHaveLength(2);
    expect(segments.filter((s) => s.x === 10)).toHaveLength(0); // empty bucket
    const req = segments.find((s) => s.x === 0 && s.type === 'request')!;
    expect(req.height).toBeCloseTo(20);
    expect(req.y).toBeCloseTo(10); // sits below the query segment
  });
  it('returns [] for no buckets', () => {
    expect(stackedBarLayout([], ['request'], 10, 10)).toEqual([]);
  });
});

describe('StackedBars', () => {
  it('renders an svg with rects', () => {
    const { container } = render(<StackedBars buckets={buckets} />);
    expect(container.querySelector('svg')).toBeTruthy();
    expect(container.querySelectorAll('rect').length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 6: Verify** — `pnpm --filter @dudousxd/nestjs-telescope-ui test`, `... typecheck`, `pnpm lint`.

- [ ] **Step 7: Commit**
```bash
git add packages/ui/src/react
git commit -m "feat(ui): per-type stacked bars + per-queue sparkline components"
```

---

## Task 2: Wire into the dashboard

**Files:** modify `packages/ui/src/app/pages/pulse-page.tsx`, `packages/ui/src/app/pages/queues-page.tsx`.

- [ ] **Step 1: Pulse page — swap the plain sparkline for stacked-by-type + a legend.** In `pulse-page.tsx`, change the import to bring `StackedBars`, `TYPE_COLOR` (for the legend) and `deriveTypes`, drop the plain `Sparkline` if it's now unused. Replace the Throughput block:
```tsx
      <div className="mb-6">
        <div className="mb-1 flex items-center justify-between">
          <p className="text-xs uppercase tracking-wide text-zinc-500">Throughput by type</p>
          <div className="flex gap-2 text-[10px] text-zinc-500">
            {deriveTypes(series.data?.buckets ?? []).map((type) => (
              <span key={type} className="flex items-center gap-1">
                <svg width={8} height={8} aria-hidden="true"><rect width={8} height={8} className={TYPE_COLOR[type] ?? 'fill-zinc-500'} /></svg>
                {type}
              </span>
            ))}
          </div>
        </div>
        <StackedBars buckets={series.data?.buckets ?? []} width={640} height={48} />
      </div>
```
(Keep the existing `const series = useTimeseries({ window, buckets: 60 });`.)

- [ ] **Step 2: Queues page — pass a per-queue sparkline render-prop.** In `queues-page.tsx`, import `QueueSparkline` and pass it to `QueuesPanel`:
```tsx
        <QueuesPanel report={data} sparkline={(queue) => <QueueSparkline queue={queue} window={window} />} />
```
(The page already has the `window` state.)

- [ ] **Step 3: Build + verify** — `pnpm --filter @dudousxd/nestjs-telescope-ui build` (confirm `dist/spa` regenerates with the new charts), `... typecheck`, `pnpm lint`, `pnpm --filter @dudousxd/nestjs-telescope-ui test` (existing green).

- [ ] **Step 4: Commit**
```bash
git add packages/ui/src/app
git commit -m "feat(ui): stacked-by-type throughput on Pulse + per-queue sparklines on Queues"
```

---

## Task 3: Changeset + whole-repo verify

**Files:** `.changeset/ui-multiseries.md`.

- [ ] **Step 1: Changeset**:
```markdown
---
'@dudousxd/nestjs-telescope-ui': minor
---

Richer dashboard charts: per-type stacked-bar throughput (with a legend) on the
Pulse page, and a per-queue throughput sparkline column on the Queues page (via
a `tag`-filtered timeseries). New `StackedBars` / `QueueSparkline` components +
`stackedBarLayout`/`deriveTypes`/`colorForType` helpers exported at `/react`;
`QueuesPanel` gains an optional `sparkline` render-prop.
```

- [ ] **Step 2: Whole-repo `pnpm build && pnpm test && pnpm lint`** — all green. Report numbers.

- [ ] **Step 3: Commit**
```bash
git add .changeset/ui-multiseries.md
git commit -m "docs: changeset for multi-series dashboard charts"
```

---

## Self-Review

**Spec coverage:** per-type stacked chart (Tasks 1–2, `StackedBars` from timeseries `byType`), per-queue sparkline (Tasks 1–2, `QueueSparkline` via `tag: 'queue:<name>'` filter + the `QueuesPanel` `sparkline` prop). Purely additive on the existing timeseries endpoint.

**Placeholder scan:** No TBDs; complete code. The pure `stackedBarLayout`/`deriveTypes` are tested; `QueueSparkline` is a thin hook+`Sparkline` composition (not separately unit-tested — needs a QueryClient/provider; the underlying `Sparkline` + `useTimeseries` are already covered). Tooltips/axes remain out of scope (dense console aesthetic).

**Type consistency:** `StackedBars`/`stackedBarLayout`/`deriveTypes`/`colorForType`/`TYPE_COLOR`/`BarSegment` live in `stacked-bars.tsx`; consume `TimeseriesBucket` (UI client type). `QueueSparkline` uses `useTimeseries` (the existing hook) + `Sparkline`. `QueuesPanel`'s new optional `sparkline?: (queue: string) => React.ReactNode` is backward-compatible (renders the Trend column only when provided; empty-state `colSpan` is `sparkline ? 8 : 7`). All exported at `/react`.
