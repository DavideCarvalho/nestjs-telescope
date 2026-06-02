# Telescope UI — Pulse + Queues Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the `@dudousxd/nestjs-telescope-ui` dashboard with the **Pulse** (health snapshot) and **Queues** (queue metrics) views, replacing the placeholder routes. Also close the one integration gap: an e2e that serves the **real built bundle** through `TelescopeUiModule`.

**Architecture:** Builds on the UI foundation (`docs/superpowers/specs/2026-06-02-telescope-ui-design.md`, plan `2026-06-02-ui-foundation-entries.md`). The client already exposes `pulse(window)` / `queues(window)` (currently loosely typed); this plan types them properly, adds `PulsePanel`/`QueuesPanel`/`WindowSelect` to the `/react` layer, and wires the two pages with a window selector. The core endpoints (`/telescope/api/pulse`, `/telescope/api/queues`) already exist.

**Tech Stack:** React 18, TanStack Query 5, Tailwind, vitest (+ jsdom + @testing-library/react), NestJS 11, biome, pnpm+turbo, changesets.

---

## Task 1: Type the Pulse + Queues client responses

**Files:** modify `packages/ui/src/client/types.ts`, `packages/ui/src/client/telescope-client.ts`; update `packages/ui/src/client/telescope-client.spec.ts`.

- [ ] **Step 1: Replace the loose `PulseReport`/`QueueMetricsReport` placeholders** in `packages/ui/src/client/types.ts` with the real shapes (mirror core's output structurally — keep them local so `/client` stays backend-agnostic):

```ts
export interface DurationStats { avg: number; p50: number; p95: number; max: number; }

export interface SlowEntry { id: string; type: string; durationMs: number; label: string; batchId: string; }
export interface ExceptionGroup { familyHash: string; class: string; message: string; count: number; lastSeen: string; }
export interface NPlusOneOccurrence { batchId: string; familyHash: string; count: number; sql: string; }

export interface PulseReport {
  windowStart: string;
  windowEnd: string;
  windowMs: number;
  counts: Record<string, number>;
  slowest: SlowEntry[];
  topExceptions: ExceptionGroup[];
  nPlusOne: NPlusOneOccurrence[];
  scanned: number;
  truncated: boolean;
}

export interface QueueMetrics {
  queue: string;
  total: number;
  completed: number;
  failed: number;
  failureRate: number;
  throughputPerMinute: number;
  runtimeMs: DurationStats | null;
  waitMs: DurationStats | null;
}
export interface QueueMetricsReport {
  windowStart: string;
  windowEnd: string;
  windowMs: number;
  queues: QueueMetrics[];
  scanned: number;
  truncated: boolean;
}
```
(Delete the old `export type PulseReport = Record<string, unknown>;` / `QueueMetricsReport = Record<string, unknown>;` lines.)

- [ ] **Step 2: The client's `pulse`/`queues` already return these named types** (`telescope-client.ts` imports `PulseReport`/`QueueMetricsReport`) — no signature change needed, they now resolve to the real shapes. Confirm the imports still compile.

- [ ] **Step 3: Strengthen the client test** — in `telescope-client.spec.ts`, the existing pulse/queues test (`fetches pulse and queues with a window param`) already asserts the URLs; that's sufficient. Add one assertion that the parsed body is returned as-is:
```ts
  it('returns the parsed pulse body', async () => {
    const body = { counts: { query: 2 }, slowest: [], topExceptions: [], nPlusOne: [], windowMs: 3600000, windowStart: '', windowEnd: '', scanned: 0, truncated: false };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as Response);
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    expect(await client.pulse('1h')).toEqual(body);
  });
```

- [ ] **Step 4: Verify** — `pnpm --filter @dudousxd/nestjs-telescope-ui test -- telescope-client`, `... typecheck`, `pnpm lint`.

- [ ] **Step 5: Commit**
```bash
git add packages/ui/src/client
git commit -m "feat(ui): type the pulse + queues client responses"
```

---

## Task 2: `PulsePanel`, `QueuesPanel`, `WindowSelect` components

**Files:** `packages/ui/src/react/components/pulse-panel.tsx`, `components/queues-panel.tsx`, `components/window-select.tsx`; update `packages/ui/src/react/index.ts`; smoke test `components/pulse-panel.spec.tsx`.

- [ ] **Step 1: `components/window-select.tsx`** (shared control):
```tsx
const WINDOWS = ['15m', '1h', '6h', '24h'] as const;

export function WindowSelect({ value, onChange }: { value: string; onChange: (w: string) => void }): JSX.Element {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-300"
    >
      {WINDOWS.map((w) => (
        <option key={w} value={w}>{w}</option>
      ))}
    </select>
  );
}
```

- [ ] **Step 2: `components/pulse-panel.tsx`** — presentational, props-driven (`report: PulseReport`). Four sections: counts (per type), slowest, top exceptions, N+1. Dark tables. A small reusable `Section` wrapper + a helper to render a stat table. Include `onSelectEntry?`/`onSelectBatch?` so a slow row / N+1 row can deep-link (optional callbacks).
```tsx
import type { PulseReport } from '../../client/index.js';

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="mb-6">
      <h3 className="mb-2 text-xs uppercase tracking-wide text-zinc-500">{title}</h3>
      {children}
    </section>
  );
}

export function PulsePanel({
  report,
  onSelectEntry,
  onSelectBatch,
}: {
  report: PulseReport;
  onSelectEntry?: (id: string) => void;
  onSelectBatch?: (batchId: string) => void;
}): JSX.Element {
  return (
    <div className="text-xs">
      {report.truncated && (
        <p className="mb-4 text-amber-500">Scan truncated at {report.scanned} entries — widen the window with care.</p>
      )}
      <Section title="Entries by type">
        <div className="flex flex-wrap gap-3">
          {Object.entries(report.counts).map(([type, count]) => (
            <span key={type} className="rounded bg-zinc-900 px-2 py-1">
              <span className="text-emerald-400">{type}</span> <span className="text-zinc-300">{count}</span>
            </span>
          ))}
          {Object.keys(report.counts).length === 0 && <span className="text-zinc-600">No entries in window.</span>}
        </div>
      </Section>

      <Section title="Slowest">
        <table className="w-full text-left">
          <tbody>
            {report.slowest.map((slow) => (
              <tr
                key={slow.id}
                onClick={() => onSelectEntry?.(slow.id)}
                className="cursor-pointer border-t border-zinc-900 hover:bg-zinc-900"
              >
                <td className="py-1 text-emerald-400">{slow.type}</td>
                <td className="max-w-md truncate text-zinc-300">{slow.label}</td>
                <td className="text-right text-zinc-400">{slow.durationMs}ms</td>
              </tr>
            ))}
            {report.slowest.length === 0 && <tr><td className="py-1 text-zinc-600">—</td></tr>}
          </tbody>
        </table>
      </Section>

      <Section title="Top exceptions">
        <table className="w-full text-left">
          <tbody>
            {report.topExceptions.map((group) => (
              <tr key={group.familyHash} className="border-t border-zinc-900">
                <td className="py-1 text-red-400">{group.class}</td>
                <td className="max-w-md truncate text-zinc-300">{group.message}</td>
                <td className="text-right text-zinc-400">×{group.count}</td>
              </tr>
            ))}
            {report.topExceptions.length === 0 && <tr><td className="py-1 text-zinc-600">No exceptions 🎉</td></tr>}
          </tbody>
        </table>
      </Section>

      <Section title="N+1 query hotspots">
        <table className="w-full text-left">
          <tbody>
            {report.nPlusOne.map((occurrence) => (
              <tr
                key={`${occurrence.batchId}:${occurrence.familyHash}`}
                onClick={() => onSelectBatch?.(occurrence.batchId)}
                className="cursor-pointer border-t border-zinc-900 hover:bg-zinc-900"
              >
                <td className="py-1 text-amber-400">×{occurrence.count}</td>
                <td className="max-w-md truncate text-zinc-300">{occurrence.sql}</td>
              </tr>
            ))}
            {report.nPlusOne.length === 0 && <tr><td className="py-1 text-zinc-600">None detected</td></tr>}
          </tbody>
        </table>
      </Section>
    </div>
  );
}
```

- [ ] **Step 3: `components/queues-panel.tsx`** (`report: QueueMetricsReport`):
```tsx
import type { DurationStats, QueueMetricsReport } from '../../client/index.js';

function p95(stats: DurationStats | null): string {
  return stats ? `${Math.round(stats.p95)}ms` : '—';
}

export function QueuesPanel({ report }: { report: QueueMetricsReport }): JSX.Element {
  return (
    <table className="w-full text-left text-xs">
      <thead className="text-zinc-500">
        <tr>
          <th className="py-2 font-normal">Queue</th>
          <th className="font-normal">Total</th>
          <th className="font-normal">Failed</th>
          <th className="font-normal">Fail %</th>
          <th className="font-normal">Per min</th>
          <th className="font-normal">Runtime p95</th>
          <th className="font-normal">Wait p95</th>
        </tr>
      </thead>
      <tbody>
        {report.queues.map((q) => (
          <tr key={q.queue} className="border-t border-zinc-900">
            <td className="py-1.5 text-emerald-400">{q.queue}</td>
            <td className="text-zinc-300">{q.total}</td>
            <td className="text-zinc-300">{q.failed}</td>
            <td className={q.failureRate > 0 ? 'text-red-400' : 'text-zinc-500'}>{(q.failureRate * 100).toFixed(1)}%</td>
            <td className="text-zinc-400">{q.throughputPerMinute.toFixed(1)}</td>
            <td className="text-zinc-400">{p95(q.runtimeMs)}</td>
            <td className="text-zinc-400">{p95(q.waitMs)}</td>
          </tr>
        ))}
        {report.queues.length === 0 && (
          <tr><td className="py-2 text-zinc-600" colSpan={7}>No queue activity in window.</td></tr>
        )}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 4: Export** — add to `packages/ui/src/react/index.ts`:
```ts
export * from './components/window-select.js';
export * from './components/pulse-panel.js';
export * from './components/queues-panel.js';
```

- [ ] **Step 5: Smoke test** `components/pulse-panel.spec.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PulseReport } from '../../client/index.js';
import { PulsePanel } from './pulse-panel.js';

const report: PulseReport = {
  windowStart: '', windowEnd: '', windowMs: 3_600_000, scanned: 3, truncated: false,
  counts: { query: 2, request: 1 },
  slowest: [{ id: 'e1', type: 'query', durationMs: 300, label: 'select 1', batchId: 'b' }],
  topExceptions: [{ familyHash: 'Error:boom', class: 'Error', message: 'boom', count: 2, lastSeen: '' }],
  nPlusOne: [{ batchId: 'b', familyHash: 'q:x', count: 6, sql: 'select * from t' }],
};

describe('PulsePanel', () => {
  it('renders counts, slowest, exceptions, and N+1', () => {
    render(<PulsePanel report={report} />);
    expect(screen.getByText('query')).toBeTruthy();
    expect(screen.getByText('select 1')).toBeTruthy();
    expect(screen.getByText('boom')).toBeTruthy();
    expect(screen.getByText('×6')).toBeTruthy();
  });
});
```

- [ ] **Step 6: Verify** — `pnpm --filter @dudousxd/nestjs-telescope-ui test`, `... typecheck`, `pnpm lint`.

> Note: if biome's a11y rule flags the clickable `<tr>` (as it did for EntriesTable), add an `onKeyDown` (Enter/Space → the same handler) to the clickable rows in `pulse-panel.tsx`, matching the EntriesTable fix.

- [ ] **Step 7: Commit**
```bash
git add packages/ui/src/react
git commit -m "feat(ui): PulsePanel + QueuesPanel + WindowSelect components"
```

---

## Task 3: Wire the Pulse + Queues pages

**Files:** `packages/ui/src/app/pages/pulse-page.tsx`, `packages/ui/src/app/pages/queues-page.tsx`; modify `packages/ui/src/app/App.tsx`.

- [ ] **Step 1: `pages/pulse-page.tsx`** — window state + `usePulse(window)` + `WindowSelect` + `PulsePanel` (deep-link slow rows to `/entries/:id` and N+1 rows to a batch filter — for v1, slow → `/entries/:id`, N+1 → `/entries` filtered by batch is not yet a route, so just `onSelectEntry` for slow; omit `onSelectBatch` or navigate to `/entries/${batchId}` is wrong — pass only `onSelectEntry`):
```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PulsePanel, WindowSelect, usePulse } from '../../react/index.js';

export function PulsePage(): JSX.Element {
  const [window, setWindow] = useState('1h');
  const navigate = useNavigate();
  const { data, isLoading } = usePulse(window);
  return (
    <div className="p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm text-emerald-400">Pulse</h2>
        <WindowSelect value={window} onChange={setWindow} />
      </div>
      {isLoading || !data ? (
        <p className="text-zinc-600">Loading…</p>
      ) : (
        <PulsePanel report={data} onSelectEntry={(id) => navigate(`/entries/${id}`)} />
      )}
    </div>
  );
}
```

- [ ] **Step 2: `pages/queues-page.tsx`**:
```tsx
import { useState } from 'react';
import { QueuesPanel, WindowSelect, useQueues } from '../../react/index.js';

export function QueuesPage(): JSX.Element {
  const [window, setWindow] = useState('1h');
  const { data, isLoading } = useQueues(window);
  return (
    <div className="p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm text-emerald-400">Queues</h2>
        <WindowSelect value={window} onChange={setWindow} />
      </div>
      {isLoading || !data ? <p className="text-zinc-600">Loading…</p> : <QueuesPanel report={data} />}
    </div>
  );
}
```

- [ ] **Step 3: Replace the placeholder routes in `App.tsx`** — import the two pages and swap the placeholder `<div>`s:
```tsx
import { PulsePage } from './pages/pulse-page.js';
import { QueuesPage } from './pages/queues-page.js';
// ...
              <Route path="/pulse" element={<PulsePage />} />
              <Route path="/queues" element={<QueuesPage />} />
```

- [ ] **Step 4: Build + verify** — `pnpm --filter @dudousxd/nestjs-telescope-ui build` (the bundle now includes both pages); confirm `dist/spa/index.html` + assets regenerated. `... typecheck`, `pnpm lint`, `pnpm --filter @dudousxd/nestjs-telescope-ui test` (existing green).

- [ ] **Step 5: Commit**
```bash
git add packages/ui/src/app
git commit -m "feat(ui): wire Pulse + Queues dashboard pages with a window selector"
```

---

## Task 4: Real-bundle serving e2e (close the integration gap)

Proves `TelescopeUiModule` serves the **actual built** `dist/spa` (real index.html + a real hashed asset with the right content-type) — the one path the fixture tests didn't cover.

**Files:** `packages/ui/src/server/telescope-ui.real-bundle.spec.ts`.

- [ ] **Step 1: Write the test** (guarded: runs only when the bundle is built, so it never fails a fresh checkout):
```ts
import 'reflect-metadata';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TelescopeUiModule } from './telescope-ui.module.js';

// src/server/*.spec.ts -> ../../dist/spa (the real Vite bundle, present after build)
const realSpaDir = fileURLToPath(new URL('../../dist/spa', import.meta.url));
const built = existsSync(realSpaDir);

describe.skipIf(!built)('TelescopeUiController serves the real built bundle', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeUiModule.forRoot({ assetsDir: realSpaDir })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('serves the real index.html referencing /telescope/assets', async () => {
    const res = await request(app.getHttpServer()).get('/telescope').expect(200);
    expect(res.text).toContain('<div id="root">');
    expect(res.text).toMatch(/\/telescope\/assets\/[\w-]+\.js/);
  });

  it('serves the real hashed JS asset referenced by index.html', async () => {
    const html = readFileSync(`${realSpaDir}/index.html`, 'utf8');
    const match = html.match(/\/telescope\/assets\/([\w-]+\.js)/);
    expect(match).toBeTruthy();
    const file = match![1];
    const res = await request(app.getHttpServer()).get(`/telescope/assets/${file}`).expect(200);
    expect(res.header['content-type']).toContain('javascript');
  });
});
```

- [ ] **Step 2: Build then run** (so the bundle exists):
```bash
pnpm --filter @dudousxd/nestjs-telescope-ui build
pnpm --filter @dudousxd/nestjs-telescope-ui test -- telescope-ui.real-bundle
```
Expected: 2 pass (the bundle exists post-build). On a clean tree without a build, the suite is skipped (0 failures).

- [ ] **Step 3: `pnpm lint`, `... typecheck`.**

- [ ] **Step 4: Commit**
```bash
git add packages/ui/src/server/telescope-ui.real-bundle.spec.ts
git commit -m "test(ui): e2e serve the real built bundle through TelescopeUiModule"
```

---

## Task 5: Changeset + whole-repo verify

**Files:** `.changeset/ui-pulse-queues.md`.

- [ ] **Step 1: Changeset**:
```markdown
---
'@dudousxd/nestjs-telescope-ui': minor
---

Complete the dashboard with Pulse (per-type counts, slowest entries, top
exceptions, N+1 hotspots) and Queues (throughput, failure rate, runtime/wait
percentiles) views, each with a window selector. Typed the `pulse()`/`queues()`
client responses and exported `PulsePanel`/`QueuesPanel`/`WindowSelect` at
`/react`. Added an e2e that serves the real built bundle.
```

- [ ] **Step 2: Whole-repo `pnpm build && pnpm test && pnpm lint`** — all green. Report numbers.

- [ ] **Step 3: Commit**
```bash
git add .changeset/ui-pulse-queues.md
git commit -m "docs: changeset for Pulse + Queues dashboard views"
```

---

## Self-Review

**Spec coverage:** the UI spec's Pulse + Queues views (`docs/.../specs/2026-06-02-telescope-ui-design.md` §Views 3–4) — typed client (Task 1), panels + window selector exported at `/react` (Task 2), wired pages (Task 3). Real-bundle serving e2e closes the foundation plan's noted gap (Task 4).

**Placeholder scan:** No TBDs. The Pulse/Queues placeholder routes from the foundation plan are now replaced with real pages. Charts/time-series remain intentionally out of scope (tables only) — noted, not stubbed.

**Type consistency:** `PulseReport`/`QueueMetricsReport` (+ `SlowEntry`/`ExceptionGroup`/`NPlusOneOccurrence`/`QueueMetrics`/`DurationStats`) are defined in `src/client/types.ts`, returned by `client.pulse()`/`client.queues()`, consumed by `usePulse()`/`useQueues()` and the `PulsePanel`/`QueuesPanel` components (props-driven, testable). `WindowSelect` is a shared control. The pages assemble hooks + panels + selector with `useState` window. Deep-links use the existing `/entries/:id` route.

**Risk note:** Task 4's default-dir resolution caveat — under vitest, `import.meta.url` is the SOURCE path, so the controller's auto-default (`../spa` from the COMPILED `dist/server`) cannot be exercised in-process; the e2e passes the resolved real `dist/spa` explicitly and validates real-bundle SERVING (real index.html + real hashed asset + content-type). The auto-default path math is simple and was verified by review; it resolves correctly in a deployed (compiled) app.
