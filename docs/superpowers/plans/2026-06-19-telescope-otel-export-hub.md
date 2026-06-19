# Telescope OTel/Grafana Export Hub — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Telescope export everything it already sees (third-party watchers + diagnostics) to OpenTelemetry/Grafana as **complete metrics** and **sampled traces**, via the existing `@dudousxd/nestjs-telescope-otel` package.

**Architecture:** A new `TelescopeOtelExporter` implements the `TelescopeExtension` contract. It taps two Recorder seams: a NEW `onRecorded(input)` hook fired at the very top of `record()` (before sampling/pause → counts stay complete) drives metrics; the existing `onFlushStored(entries)` hook (post-sampling) drives spans. Metrics are kept in dependency-free internal counters for a Prometheus `/metrics` scrape AND mirrored into the OTel Meter API for OTLP push; spans go through the OTel Tracer API. Both OTel paths degrade to no-op when the host has no OTel SDK.

**Tech Stack:** TypeScript (ESM, NodeNext), NestJS, vitest, pnpm + turbo monorepo, `@opentelemetry/api` (existing peer; metrics + trace surfaces).

## Global Constraints

- Package manager: **pnpm** (`pnpm@9.0.0`); monorepo orchestrated by **turbo**. Node `>=20`.
- ESM only. Relative imports MUST use the `.js` extension (NodeNext), e.g. `import { Recorder } from './recorder.js'`.
- The ONLY new third-party dependency permitted is nothing — reuse the existing `@opentelemetry/api` peer (`>=1.0.0`) in `packages/otel`. No `@opentelemetry/sdk-*` added as a runtime dep.
- Tests: **vitest**. Run a single package's tests with `pnpm --filter <pkgname> test` (e.g. `pnpm --filter @dudousxd/nestjs-telescope test`). Run one file with `npx vitest run <path>` from inside the package dir.
- Hot-path rule: `Recorder.record()` MUST remain synchronous, O(1), and never throw into the caller. Any new hook call is wrapped in its own `try/catch` that swallows.
- Best-effort observability rule: an exporter/hook failure must NEVER break `record()` or `flush()`.
- Naming: OTel package id is `@dudousxd/nestjs-telescope-otel`; core package id is `@dudousxd/nestjs-telescope`. The extension's `name` field is `'otel-export'`.
- Commit style: conventional commits (`feat:`, `test:`, `chore:`). Commit per task (each task ends green).

## File Structure

**Core (`packages/core/src`):**
- Modify `recorder/recorder.ts` — add `onRecorded?` to `RecorderOptions`; call it first thing in `record()` via a new private `notifyRecorded`.
- Modify `extension/types.ts` — add optional `observeRecord?` / `observeFlush?` to `TelescopeExtension`.
- Modify `extension/registry.ts` — accumulate observers; expose `notifyRecord(input)` / `notifyFlush(entries)`.
- Modify `nest/telescope.service.ts` — wire `onRecorded` to `registry.notifyRecord`; append `registry.notifyFlush` to the existing `onFlushStored` closure.

**OTel package (`packages/otel/src`):**
- Create `instrument-map.ts` — pure `EntryType → metric` mapping + a `MetricStore` (internal counters/histograms, Prometheus text).
- Create `entry-to-span.ts` — pure `Entry → { name, startTime, endTime, attributes }`.
- Create `telescope-otel-exporter.ts` — `TelescopeOtelExporter` (implements `TelescopeExtension`): `observeRecord`, `observeFlush`, `prometheus()`.
- Create `metrics.controller.ts` + `telescope-otel-metrics.module.ts` — optional `/metrics` route.
- Modify `index.ts` — export the new public surface.
- Docs: create `packages/otel/README.md` "Export" section + a root `docs/observability.md` covering `emit()` for user libs.

---

### Task 1: Core — `onRecorded` hook on the Recorder

**Files:**
- Modify: `packages/core/src/recorder/recorder.ts` (`RecorderOptions` interface near line 155; `record()` near line 354; add `notifyRecorded` near the other `notify*` private methods near line 500)
- Test: `packages/core/src/recorder/recorder.spec.ts`

**Interfaces:**
- Produces: `RecorderOptions.onRecorded?(input: RecordInput): void` — fired exactly once per `record()` call, BEFORE the pause check and sampling, so counts are complete. Isolated `try/catch`; a throw is swallowed and does NOT increment any drop counter.

- [ ] **Step 1: Write the failing test**

Add inside `recorder.spec.ts` (it already has `import` for `Recorder` and the `makeRecorder` helper):

```ts
describe('onRecorded hook', () => {
  it('fires for every record() with the raw input, before sampling', () => {
    const seen: RecordInput[] = [];
    const { recorder } = makeRecorder({
      sampling: { query: 0 }, // sample OUT every query
      onRecorded: (input) => seen.push(input),
    });
    recorder.record({ type: 'query', content: { sql: 'select 1', bindings: [], took: 1 } });
    // Sampling dropped it from storage, but the metrics tap still saw it.
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe('query');
  });

  it('fires even while paused (so counts stay complete under overload)', () => {
    const seen: RecordInput[] = [];
    const { recorder } = makeRecorder({ onRecorded: (input) => seen.push(input) });
    recorder.pause();
    recorder.record({ type: 'request', content: { method: 'GET', statusCode: 200 } });
    expect(seen).toHaveLength(1);
    expect(recorder.overflowDropped).toBe(1); // still dropped from storage
  });

  it('swallows a throwing hook without counting a drop or breaking record()', () => {
    const { recorder, storage } = makeRecorder({
      onRecorded: () => {
        throw new Error('hook boom');
      },
    });
    expect(() => recorder.record({ type: 'log', content: { message: 'x' } })).not.toThrow();
    expect(recorder.droppedCount).toBe(0); // hook error is isolated, not a record-error
  });
});
```

Add `RecordInput` to the existing type import at the top of the spec:
```ts
import type { Entry, RecordInput } from '../entry/entry.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `packages/core`): `npx vitest run src/recorder/recorder.spec.ts -t "onRecorded"`
Expected: FAIL — `onRecorded` is not a known option / hook never called.

- [ ] **Step 3: Add the option to `RecorderOptions`**

In `recorder.ts`, immediately after the `onFlushStored?` field (around line 155):

```ts
  /**
   * Best-effort hook fired with the RAW input of EVERY `record()` call, BEFORE
   * the pause check and sampling — so a metrics consumer sees complete counts
   * even when the entry is sampled out or dropped under overload. Called inside
   * its own try/catch; a throw is swallowed and never counted as a drop, never
   * breaks the synchronous record path. Powers the OTel/Prometheus metrics tap.
   */
  onRecorded?: (input: RecordInput) => void;
```

- [ ] **Step 4: Call it first thing in `record()` and add `notifyRecorded`**

Change the top of `record()` (line 354) so the tap runs before everything:

```ts
  /** Synchronous, O(1), never throws into the caller. */
  record(input: RecordInput): void {
    // Complete-count metrics tap: fires before pause/sampling so counters never
    // under-report under overload. Isolated so a tap bug can't affect capture.
    this.notifyRecorded(input);
    try {
      if (this.paused) {
```

Add the private method next to `notifyFlushStored` (after line 507):

```ts
  /**
   * Invoke the `onRecorded` tap with the raw input. Isolated try/catch: a tap
   * failure is swallowed and is NOT a drop — capture continues unaffected.
   */
  private notifyRecorded(input: RecordInput): void {
    if (this.options.onRecorded === undefined) return;
    try {
      this.options.onRecorded(input);
    } catch {
      // Best-effort metrics tap; never break record().
    }
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/recorder/recorder.spec.ts -t "onRecorded"`
Expected: PASS (3 tests). Then run the whole file: `npx vitest run src/recorder/recorder.spec.ts` — expected PASS (existing + 3 new).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/recorder/recorder.ts packages/core/src/recorder/recorder.spec.ts
git commit -m "feat(core): add complete-count onRecorded tap to Recorder"
```

---

### Task 2: Core — `observeRecord` / `observeFlush` on the extension SPI

**Files:**
- Modify: `packages/core/src/extension/types.ts` (`TelescopeExtension` interface, line 18-29)
- Modify: `packages/core/src/extension/registry.ts` (accumulate observers + add `notifyRecord` / `notifyFlush`)
- Test: `packages/core/src/extension/registry.spec.ts`

**Interfaces:**
- Consumes: `RecordInput`, `Entry` from `../entry/entry.js`.
- Produces:
  - `TelescopeExtension.observeRecord?(input: RecordInput): void`
  - `TelescopeExtension.observeFlush?(entries: Entry[]): void | Promise<void>`
  - `ExtensionRegistry.notifyRecord(input: RecordInput): void` — fan out to every registered `observeRecord`, each isolated.
  - `ExtensionRegistry.notifyFlush(entries: Entry[]): Promise<void>` — awaits every registered `observeFlush`, each isolated.

- [ ] **Step 1: Write the failing test**

In `registry.spec.ts` (follow the file's existing extension-construction pattern — read the top of the file for the `ExtensionRegistry` constructor signature and the `ExtensionContext` it passes):

```ts
describe('observe hooks', () => {
  it('notifyRecord fans out to every observeRecord, isolating throwers', () => {
    const seenA: string[] = [];
    const reg = new ExtensionRegistry(
      [
        { name: 'a', observeRecord: (i) => seenA.push(i.type) },
        { name: 'b', observeRecord: () => { throw new Error('boom'); } },
      ],
      {} as ExtensionContext,
    );
    expect(() =>
      reg.notifyRecord({ type: 'query', content: {} }),
    ).not.toThrow();
    expect(seenA).toEqual(['query']);
  });

  it('notifyFlush awaits every observeFlush, isolating throwers', async () => {
    const seen: number[] = [];
    const reg = new ExtensionRegistry(
      [
        { name: 'a', observeFlush: (e) => { seen.push(e.length); } },
        { name: 'b', observeFlush: () => Promise.reject(new Error('boom')) },
      ],
      {} as ExtensionContext,
    );
    await expect(reg.notifyFlush([{ type: 'request' } as Entry])).resolves.toBeUndefined();
    expect(seen).toEqual([1]);
  });
});
```

Ensure imports at the top of the spec include:
```ts
import type { Entry, RecordInput } from '../entry/entry.js';
import type { ExtensionContext } from './types.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `packages/core`): `npx vitest run src/extension/registry.spec.ts -t "observe hooks"`
Expected: FAIL — `notifyRecord` / `notifyFlush` are not methods on `ExtensionRegistry`.

- [ ] **Step 3: Add the hooks to the contract**

In `extension/types.ts`, inside `TelescopeExtension` (after `dataProviders?`, line 28):

```ts
  /**
   * Observe EVERY recorded input (pre-sampling, complete counts) — drives metrics
   * export. Fired synchronously on the hot path; keep it cheap. Isolated by the
   * host: a throw is swallowed and never affects capture.
   */
  observeRecord?(input: RecordInput): void;
  /**
   * Observe each just-persisted (post-sampling) batch — drives span/trace export.
   * Awaited off the host path inside the flush chain; a throw/rejection is
   * swallowed and never breaks the flush.
   */
  observeFlush?(entries: Entry[]): void | Promise<void>;
```

Add the imports at the top of `types.ts`:
```ts
import type { Entry, RecordInput } from '../entry/entry.js';
```

- [ ] **Step 4: Accumulate + notify in the registry**

In `registry.ts`, mirror the existing `_watchers` accumulation pattern. Add fields next to `_watchers` (line 17):

```ts
  private readonly _recordObservers: Array<(input: RecordInput) => void> = [];
  private readonly _flushObservers: Array<(entries: Entry[]) => void | Promise<void>> = [];
```

In the constructor loop that already does `for (const w of ext.watchers?.(ctx) ?? [])` (line 30), add after it:

```ts
      if (ext.observeRecord) this._recordObservers.push(ext.observeRecord.bind(ext));
      if (ext.observeFlush) this._flushObservers.push(ext.observeFlush.bind(ext));
```

Add the two notify methods near `watchers()` (line 67):

```ts
  /** Fan out a recorded input to every observer; isolate throwers (hot path). */
  notifyRecord(input: RecordInput): void {
    for (const observe of this._recordObservers) {
      try {
        observe(input);
      } catch {
        // Best-effort; one observer's bug must not affect capture or the others.
      }
    }
  }

  /** Await every flush observer; isolate throwers/rejections (off the host path). */
  async notifyFlush(entries: Entry[]): Promise<void> {
    for (const observe of this._flushObservers) {
      try {
        await observe(entries);
      } catch {
        // Best-effort; never break the flush.
      }
    }
  }
```

Add imports at the top of `registry.ts`:
```ts
import type { Entry, RecordInput } from '../entry/entry.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/extension/registry.spec.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/extension/types.ts packages/core/src/extension/registry.ts packages/core/src/extension/registry.spec.ts
git commit -m "feat(core): add observeRecord/observeFlush extension hooks"
```

---

### Task 3: Core — wire the registry observers into the Recorder

**Files:**
- Modify: `packages/core/src/nest/telescope.service.ts` (Recorder construction, lines 155-182)
- Test: `packages/core/src/nest/telescope.service.spec.ts` (or the nearest existing service/integration spec — reuse the file that already constructs a `TelescopeService`; search for `new TelescopeService` / `TelescopeService` in `src/nest/*.spec.ts`)

**Interfaces:**
- Consumes: `ExtensionRegistry.notifyRecord` / `notifyFlush` (Task 2); `Recorder.onRecorded` (Task 1).
- Produces: the running `TelescopeService` now forwards every record to `extensions.notifyRecord` and every stored flush batch to `extensions.notifyFlush` (in addition to the existing diagnosis/SSE/alerter work).

- [ ] **Step 1: Write the failing test**

Add a test that registers an extension with both observers and asserts they fire through a real service. Follow the existing spec's setup for building a `TelescopeService` with `extensions`. Skeleton (adapt the construction to the spec's existing helper):

```ts
it('forwards records and flushes to extension observers', async () => {
  const recorded: string[] = [];
  const flushed: number[] = [];
  const ext = {
    name: 'probe',
    observeRecord: (i: RecordInput) => recorded.push(i.type),
    observeFlush: (e: Entry[]) => { flushed.push(e.length); },
  };
  const service = makeService({ extensions: [ext] }); // helper builds an ExtensionRegistry from these
  service.record({ type: 'request', content: { method: 'GET', statusCode: 200 } });
  await service.flushNow(); // use the spec's existing flush trigger (or recorder.flush())
  expect(recorded).toEqual(['request']);
  expect(flushed).toEqual([1]);
});
```

> Note for the implementer: if no `makeService` helper exists, construct the registry directly — `new ExtensionRegistry([ext], ctx)` — and pass it as the `TELESCOPE_EXTENSIONS` constructor arg, matching how `telescope.service.ts` injects `extensions` (constructor param at line 130). Trigger a flush via the recorder the service owns.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/nest/telescope.service.spec.ts -t "extension observers"`
Expected: FAIL — observers never called.

- [ ] **Step 3: Wire `onRecorded` and extend `onFlushStored`**

In `telescope.service.ts`, in the `new Recorder({ ... })` options (lines 155-182):

Add an `onRecorded` option (anywhere in the option object, e.g. right before `onFlushStored`):

```ts
      // Complete-count metrics tap: fan every record out to extension observers
      // (e.g. the OTel exporter) before sampling, so exported counters are honest.
      onRecorded: (input) => this.extensions.notifyRecord(input),
```

Extend the existing `onFlushStored` closure (line 177) to also notify flush observers AFTER the current work:

```ts
      onFlushStored: (entries) => {
        this.diagnosis?.observeFlush(entries);
        this.entryEvents.emitTypes(entries.map((e) => e.type));
        // Span/trace export and any other extension flush consumers. Awaited so
        // the flush chain settles them; the registry isolates each (never throws).
        const observers = this.extensions.notifyFlush(entries);
        const alert = this.alerter?.evaluateFlush(entries);
        return Promise.all([observers, alert]).then(() => undefined);
      },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/nest/telescope.service.spec.ts`
Expected: PASS (existing + new).

- [ ] **Step 5: Run the full core test suite (guard against regressions in the flush closure)**

Run (from repo root worktree): `pnpm --filter @dudousxd/nestjs-telescope test`
Expected: PASS (the only pre-existing anomaly is a flaky parallel module-resolution hiccup in `http-client.watcher.spec.ts` that passes when run in isolation — unrelated to these changes; re-run that file alone to confirm green if it appears).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/nest/telescope.service.ts packages/core/src/nest/telescope.service.spec.ts
git commit -m "feat(core): fan recorder taps out to extension observers"
```

---

### Task 4: OTel — metric instrument map + internal store + `observeRecord`

**Files:**
- Create: `packages/otel/src/instrument-map.ts`
- Create: `packages/otel/src/instrument-map.spec.ts`
- Create: `packages/otel/src/telescope-otel-exporter.ts` (metrics half this task; spans added in Task 6)
- Create: `packages/otel/src/telescope-otel-exporter.spec.ts`

**Interfaces:**
- Consumes: `RecordInput`, `EntryType` from `@dudousxd/nestjs-telescope`; `metrics` from `@opentelemetry/api`.
- Produces:
  - `interface MetricSample { counter: string; labels: Record<string, string>; durationMs: number | null; durationMetric?: string }`
  - `function mapInput(input: RecordInput): MetricSample | null` — pure; returns null for unmapped types.
  - `class MetricStore` with `add(sample: MetricSample): void` and `prometheus(): string` (dependency-free text exposition: `<counter>_total{labels} N`, plus `<dur>_ms_sum`/`_count`).
  - `class TelescopeOtelExporter implements TelescopeExtension` with `name='otel-export'` and `observeRecord(input)`.

- [ ] **Step 1: Write the failing test for the map + store**

`instrument-map.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mapInput, MetricStore } from './instrument-map.js';

describe('mapInput', () => {
  it('maps a request to a counter + duration metric with method/status labels', () => {
    const s = mapInput({
      type: 'request',
      content: { method: 'GET', statusCode: 200 },
      durationMs: 12,
    });
    expect(s).toEqual({
      counter: 'telescope_requests_total',
      labels: { method: 'GET', status: '200' },
      durationMs: 12,
      durationMetric: 'telescope_request_duration_ms',
    });
  });

  it('maps an exception to a counter labelled by class', () => {
    const s = mapInput({ type: 'exception', content: { class: 'TypeError' } });
    expect(s?.counter).toBe('telescope_exceptions_total');
    expect(s?.labels).toEqual({ class: 'TypeError' });
  });

  it('maps a diagnostic entry to the generic counter with lib/event labels', () => {
    const s = mapInput({
      type: 'diagnostic',
      content: { lib: 'authz', event: 'decision' },
    });
    expect(s).toEqual({
      counter: 'telescope_diagnostic_total',
      labels: { lib: 'authz', event: 'decision' },
      durationMs: null,
    });
  });

  it('returns null for an unmapped type', () => {
    expect(mapInput({ type: 'dump', content: {} })).toBeNull();
  });
});

describe('MetricStore.prometheus', () => {
  it('emits counter totals and duration sum/count', () => {
    const store = new MetricStore();
    store.add({ counter: 'telescope_requests_total', labels: { method: 'GET', status: '200' }, durationMs: 10, durationMetric: 'telescope_request_duration_ms' });
    store.add({ counter: 'telescope_requests_total', labels: { method: 'GET', status: '200' }, durationMs: 30, durationMetric: 'telescope_request_duration_ms' });
    const text = store.prometheus();
    expect(text).toContain('telescope_requests_total{method="GET",status="200"} 2');
    expect(text).toContain('telescope_request_duration_ms_sum{method="GET",status="200"} 40');
    expect(text).toContain('telescope_request_duration_ms_count{method="GET",status="200"} 2');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `packages/otel`): `npx vitest run src/instrument-map.spec.ts`
Expected: FAIL — module `./instrument-map.js` not found.

- [ ] **Step 3: Implement `instrument-map.ts`**

```ts
import { EntryType, type RecordInput } from '@dudousxd/nestjs-telescope';

export interface MetricSample {
  counter: string;
  labels: Record<string, string>;
  durationMs: number | null;
  /** When set, also feed `durationMs` into this histogram/summary. */
  durationMetric?: string;
}

/** Pure: RecordInput -> the metric it contributes, or null if not exported. */
export function mapInput(input: RecordInput): MetricSample | null {
  const c = (input.content ?? {}) as Record<string, unknown>;
  const dur = input.durationMs ?? null;
  switch (input.type) {
    case EntryType.Request:
      return {
        counter: 'telescope_requests_total',
        labels: { method: String(c.method ?? ''), status: String(c.statusCode ?? '') },
        durationMs: dur,
        durationMetric: 'telescope_request_duration_ms',
      };
    case EntryType.Query:
      return {
        counter: 'telescope_queries_total',
        labels: { db: String(c.connection ?? c.db ?? 'default') },
        durationMs: dur,
        durationMetric: 'telescope_query_duration_ms',
      };
    case EntryType.Job:
      return {
        counter: 'telescope_jobs_total',
        labels: { status: String(c.status ?? (c.failed ? 'failed' : 'completed')) },
        durationMs: dur,
        durationMetric: 'telescope_job_duration_ms',
      };
    case EntryType.Exception:
    case EntryType.ClientException:
      return {
        counter: 'telescope_exceptions_total',
        labels: { class: String(c.class ?? c.name ?? 'Error') },
        durationMs: null,
      };
    case EntryType.Cache:
      return {
        counter: 'telescope_cache_total',
        labels: { result: c.hit === true ? 'hit' : c.hit === false ? 'miss' : 'write' },
        durationMs: null,
      };
    case EntryType.HttpClient:
      return {
        counter: 'telescope_http_client_total',
        labels: { host: String(c.host ?? ''), status: String(c.statusCode ?? '') },
        durationMs: dur,
        durationMetric: 'telescope_http_client_duration_ms',
      };
    case 'diagnostic':
      return {
        counter: 'telescope_diagnostic_total',
        labels: { lib: String(c.lib ?? ''), event: String(c.event ?? '') },
        durationMs: null,
      };
    default:
      return null;
  }
}

interface CounterCell { count: number; durSum: number; durCount: number; durMetric?: string }

/** Dependency-free internal aggregation for the Prometheus `/metrics` scrape. */
export class MetricStore {
  private readonly cells = new Map<string, { sample: MetricSample; cell: CounterCell }>();

  add(sample: MetricSample): void {
    const key = `${sample.counter}|${serializeLabels(sample.labels)}`;
    let entry = this.cells.get(key);
    if (entry === undefined) {
      entry = { sample, cell: { count: 0, durSum: 0, durCount: 0, durMetric: sample.durationMetric } };
      this.cells.set(key, entry);
    }
    entry.cell.count += 1;
    if (sample.durationMs !== null && sample.durationMetric) {
      entry.cell.durSum += sample.durationMs;
      entry.cell.durCount += 1;
    }
  }

  prometheus(): string {
    const lines: string[] = [];
    for (const { sample, cell } of this.cells.values()) {
      const labels = serializeLabels(sample.labels);
      lines.push(`${sample.counter}${labels} ${cell.count}`);
      if (cell.durMetric && cell.durCount > 0) {
        lines.push(`${cell.durMetric}_sum${labels} ${cell.durSum}`);
        lines.push(`${cell.durMetric}_count${labels} ${cell.durCount}`);
      }
    }
    return lines.join('\n') + (lines.length ? '\n' : '');
  }
}

function serializeLabels(labels: Record<string, string>): string {
  const parts = Object.entries(labels)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
}
```

- [ ] **Step 4: Run map/store tests to verify they pass**

Run: `npx vitest run src/instrument-map.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing exporter test (`observeRecord` → store + OTel meter)**

`telescope-otel-exporter.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TelescopeOtelExporter } from './telescope-otel-exporter.js';

describe('TelescopeOtelExporter.observeRecord', () => {
  it('is a TelescopeExtension named otel-export', () => {
    const exporter = new TelescopeOtelExporter();
    expect(exporter.name).toBe('otel-export');
    expect(typeof exporter.observeRecord).toBe('function');
  });

  it('aggregates records into the Prometheus exposition', () => {
    const exporter = new TelescopeOtelExporter();
    exporter.observeRecord({ type: 'request', content: { method: 'GET', statusCode: 200 }, durationMs: 5 });
    exporter.observeRecord({ type: 'request', content: { method: 'GET', statusCode: 200 }, durationMs: 7 });
    const text = exporter.prometheus();
    expect(text).toContain('telescope_requests_total{method="GET",status="200"} 2');
  });

  it('ignores unmapped types', () => {
    const exporter = new TelescopeOtelExporter();
    exporter.observeRecord({ type: 'dump', content: {} });
    expect(exporter.prometheus()).toBe('');
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run src/telescope-otel-exporter.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement the metrics half of `telescope-otel-exporter.ts`**

```ts
import { type Counter, type Histogram, type Meter, metrics } from '@opentelemetry/api';
import type { RecordInput, TelescopeExtension } from '@dudousxd/nestjs-telescope';
import { mapInput, MetricStore } from './instrument-map.js';

export interface TelescopeOtelExporterOptions {
  /** OTel Meter for OTLP push. Defaults to the global meter (no-op without an SDK). */
  meter?: Meter;
}

/**
 * Exports everything Telescope records as complete metrics (and, in Task 6,
 * sampled spans). Implements TelescopeExtension: pass it to
 * `TelescopeModule.forRoot({ extensions: [exporter] })`.
 */
export class TelescopeOtelExporter implements TelescopeExtension {
  readonly name = 'otel-export';
  private readonly store = new MetricStore();
  private readonly meter: Meter;
  private readonly counters = new Map<string, Counter>();
  private readonly histograms = new Map<string, Histogram>();

  constructor(private readonly options: TelescopeOtelExporterOptions = {}) {
    this.meter = options.meter ?? metrics.getMeter('telescope');
  }

  observeRecord(input: RecordInput): void {
    const sample = mapInput(input);
    if (sample === null) return;
    // Dependency-free aggregation for the Prometheus scrape.
    this.store.add(sample);
    // Mirror into the OTel Meter for OTLP push (no-op without an SDK).
    this.counter(sample.counter).add(1, sample.labels);
    if (sample.durationMetric && sample.durationMs !== null) {
      this.histogram(sample.durationMetric).record(sample.durationMs, sample.labels);
    }
  }

  /** Prometheus text exposition for a `/metrics` scrape. */
  prometheus(): string {
    return this.store.prometheus();
  }

  private counter(name: string): Counter {
    let c = this.counters.get(name);
    if (c === undefined) {
      c = this.meter.createCounter(name);
      this.counters.set(name, c);
    }
    return c;
  }

  private histogram(name: string): Histogram {
    let h = this.histograms.get(name);
    if (h === undefined) {
      h = this.meter.createHistogram(name, { unit: 'ms' });
      this.histograms.set(name, h);
    }
    return h;
  }
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run src/telescope-otel-exporter.spec.ts src/instrument-map.spec.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/otel/src/instrument-map.ts packages/otel/src/instrument-map.spec.ts packages/otel/src/telescope-otel-exporter.ts packages/otel/src/telescope-otel-exporter.spec.ts
git commit -m "feat(otel): export Telescope records as metrics (prometheus + OTel meter)"
```

---

### Task 5: OTel — `/metrics` controller + Nest module

**Files:**
- Create: `packages/otel/src/metrics.controller.ts`
- Create: `packages/otel/src/telescope-otel-metrics.module.ts`
- Create: `packages/otel/src/metrics.controller.spec.ts`

**Interfaces:**
- Consumes: `TelescopeOtelExporter` (Task 4).
- Produces:
  - `const TELESCOPE_OTEL_EXPORTER: unique symbol` injection token.
  - `class TelescopeOtelMetricsController` — `GET /metrics` returns `exporter.prometheus()` with `text/plain; version=0.0.4`.
  - `TelescopeOtelMetricsModule.forExporter(exporter: TelescopeOtelExporter): DynamicModule` — binds the SAME instance the host passed to `TelescopeModule.forRoot({ extensions: [exporter] })`.

- [ ] **Step 1: Write the failing test**

`metrics.controller.spec.ts` (call the controller directly — no HTTP server needed):

```ts
import { describe, expect, it } from 'vitest';
import { TelescopeOtelExporter } from './telescope-otel-exporter.js';
import { TelescopeOtelMetricsController } from './metrics.controller.js';

describe('TelescopeOtelMetricsController', () => {
  it('serves the exporter Prometheus text', () => {
    const exporter = new TelescopeOtelExporter();
    exporter.observeRecord({ type: 'request', content: { method: 'GET', statusCode: 200 } });
    const controller = new TelescopeOtelMetricsController(exporter);
    expect(controller.metrics()).toContain('telescope_requests_total');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/metrics.controller.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the controller**

`metrics.controller.ts`:

```ts
import { Controller, Get, Header, Inject } from '@nestjs/common';
import { TelescopeOtelExporter } from './telescope-otel-exporter.js';

export const TELESCOPE_OTEL_EXPORTER = Symbol.for('telescope-otel-exporter');

@Controller()
export class TelescopeOtelMetricsController {
  constructor(
    @Inject(TELESCOPE_OTEL_EXPORTER) private readonly exporter: TelescopeOtelExporter,
  ) {}

  /** Prometheus scrape of everything Telescope records. */
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  metrics(): string {
    return this.exporter.prometheus();
  }
}
```

`telescope-otel-metrics.module.ts`:

```ts
import { type DynamicModule, Module } from '@nestjs/common';
import { TELESCOPE_OTEL_EXPORTER, TelescopeOtelMetricsController } from './metrics.controller.js';
import { TelescopeOtelExporter } from './telescope-otel-exporter.js';

/**
 * Mounts `GET /metrics` (Prometheus) for the exporter. Pass the SAME exporter
 * instance you registered as a Telescope extension so the scrape reflects live
 * records. Mount path is owned by the host (e.g. via RouterModule or the module
 * import site).
 */
@Module({})
export class TelescopeOtelMetricsModule {
  static forExporter(exporter: TelescopeOtelExporter): DynamicModule {
    return {
      module: TelescopeOtelMetricsModule,
      controllers: [TelescopeOtelMetricsController],
      providers: [{ provide: TELESCOPE_OTEL_EXPORTER, useValue: exporter }],
    };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/metrics.controller.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/otel/src/metrics.controller.ts packages/otel/src/telescope-otel-metrics.module.ts packages/otel/src/metrics.controller.spec.ts
git commit -m "feat(otel): serve /metrics Prometheus scrape"
```

---

### Task 6: OTel — `observeFlush` → spans (sampled traces)

**Files:**
- Create: `packages/otel/src/entry-to-span.ts`
- Create: `packages/otel/src/entry-to-span.spec.ts`
- Modify: `packages/otel/src/telescope-otel-exporter.ts` (add `observeFlush` + tracer)
- Modify: `packages/otel/src/telescope-otel-exporter.spec.ts` (add span tests)

**Interfaces:**
- Consumes: `Entry` from `@dudousxd/nestjs-telescope`; `trace`, `Tracer` from `@opentelemetry/api`.
- Produces:
  - `interface SpanShape { name: string; startMs: number; endMs: number; attributes: Record<string, string | number>; traceId: string | null; spanId: string | null }`
  - `function entryToSpan(entry: Entry): SpanShape` — pure mapping.
  - `TelescopeOtelExporter.observeFlush(entries: Entry[]): void` — emits one span per entry through the OTel tracer.

- [ ] **Step 1: Write the failing test for the pure mapping**

`entry-to-span.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { entryToSpan } from './entry-to-span.js';
import type { Entry } from '@dudousxd/nestjs-telescope';

function entry(over: Partial<Entry>): Entry {
  return {
    id: 'e1', batchId: 'b1', type: 'request', familyHash: null, content: {},
    tags: [], sequence: 0, durationMs: 20, origin: 'http', instanceId: 'pod-1',
    traceId: 'abc', spanId: 'def', createdAt: new Date(1_000), ...over,
  } as Entry;
}

describe('entryToSpan', () => {
  it('names the span by type and spans [createdAt, createdAt+durationMs]', () => {
    const s = entryToSpan(entry({ type: 'query', durationMs: 5, createdAt: new Date(1_000) }));
    expect(s.name).toBe('telescope.query');
    expect(s.startMs).toBe(1_000);
    expect(s.endMs).toBe(1_005);
    expect(s.attributes['telescope.type']).toBe('query');
    expect(s.traceId).toBe('abc');
  });

  it('treats a null duration as a zero-length span', () => {
    const s = entryToSpan(entry({ durationMs: null, createdAt: new Date(2_000) }));
    expect(s.endMs).toBe(2_000);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/entry-to-span.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `entry-to-span.ts`**

```ts
import type { Entry } from '@dudousxd/nestjs-telescope';

export interface SpanShape {
  name: string;
  startMs: number;
  endMs: number;
  attributes: Record<string, string | number>;
  traceId: string | null;
  spanId: string | null;
}

/** Pure: a recorded Entry -> the shape of the span it should produce. */
export function entryToSpan(entry: Entry): SpanShape {
  const startMs = entry.createdAt.getTime();
  const endMs = startMs + (entry.durationMs ?? 0);
  const attributes: Record<string, string | number> = {
    'telescope.type': entry.type,
    'telescope.batch_id': entry.batchId,
  };
  if (entry.durationMs !== null) attributes['telescope.duration_ms'] = entry.durationMs;
  for (const tag of entry.tags) attributes[`telescope.tag.${tag}`] = 1;
  return { name: `telescope.${entry.type}`, startMs, endMs, attributes, traceId: entry.traceId, spanId: entry.spanId };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/entry-to-span.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing span-emission test (real OTel SDK in-memory)**

This test needs the SDK ONLY as a devDependency to assert emission. Add `@opentelemetry/sdk-trace-base` to `packages/otel` devDependencies (NOT runtime deps — Global Constraints forbid runtime SDK deps only). Append to `telescope-otel-exporter.spec.ts`:

```ts
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { trace } from '@opentelemetry/api';
import type { Entry } from '@dudousxd/nestjs-telescope';

describe('TelescopeOtelExporter.observeFlush', () => {
  it('emits one span per entry through the OTel tracer', () => {
    const memory = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memory)] });
    trace.setGlobalTracerProvider(provider);

    const exporter = new TelescopeOtelExporter();
    exporter.observeFlush([
      { id: 'e1', batchId: 'b', type: 'request', familyHash: null, content: {}, tags: [],
        sequence: 0, durationMs: 12, origin: 'http', instanceId: 'p', traceId: null,
        spanId: null, createdAt: new Date(1_000) } as Entry,
    ]);

    const spans = memory.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('telescope.request');
    expect(spans[0].attributes['telescope.type']).toBe('request');
    trace.disable();
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope-otel add -D @opentelemetry/sdk-trace-base` then `npx vitest run src/telescope-otel-exporter.spec.ts -t "observeFlush"`
Expected: FAIL — `observeFlush` is not a function.

- [ ] **Step 7: Implement `observeFlush` + tracer in `telescope-otel-exporter.ts`**

Add to the imports:
```ts
import { type Tracer, trace } from '@opentelemetry/api';
import type { Entry, RecordInput, TelescopeExtension } from '@dudousxd/nestjs-telescope';
import { entryToSpan } from './entry-to-span.js';
```

Add a tracer field + option:
```ts
  private readonly tracer: Tracer;
```
In the constructor:
```ts
    this.tracer = options.tracer ?? trace.getTracer('telescope');
```
Extend `TelescopeOtelExporterOptions`:
```ts
  /** OTel Tracer for span export. Defaults to the global tracer (no-op without an SDK). */
  tracer?: Tracer;
```

Add the method:
```ts
  observeFlush(entries: Entry[]): void {
    for (const entry of entries) {
      const shape = entryToSpan(entry);
      const span = this.tracer.startSpan(shape.name, {
        startTime: shape.startMs,
        attributes: shape.attributes,
      });
      span.end(shape.endMs);
    }
  }
```

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run src/telescope-otel-exporter.spec.ts src/entry-to-span.spec.ts`
Expected: PASS (all metrics + span tests).

- [ ] **Step 9: Commit**

```bash
git add packages/otel/src/entry-to-span.ts packages/otel/src/entry-to-span.spec.ts packages/otel/src/telescope-otel-exporter.ts packages/otel/src/telescope-otel-exporter.spec.ts packages/otel/package.json
git commit -m "feat(otel): export Telescope flushes as sampled OTel spans"
```

---

### Task 7: OTel — public exports + documentation

**Files:**
- Modify: `packages/otel/src/index.ts`
- Modify: `packages/otel/README.md` (add an "Export" section)
- Create: `docs/observability.md` (root of the telescope repo)

**Interfaces:**
- Consumes: everything above.
- Produces: the package's public surface.

- [ ] **Step 1: Export the new surface**

Replace `packages/otel/src/index.ts` with:

```ts
// packages/otel/src/index.ts
export * from './otel-trace-context-provider.js';
export { TelescopeOtelExporter, type TelescopeOtelExporterOptions } from './telescope-otel-exporter.js';
export { TelescopeOtelMetricsModule } from './telescope-otel-metrics.module.js';
export { TELESCOPE_OTEL_EXPORTER, TelescopeOtelMetricsController } from './metrics.controller.js';
export { mapInput, MetricStore, type MetricSample } from './instrument-map.js';
export { entryToSpan, type SpanShape } from './entry-to-span.js';
```

- [ ] **Step 2: Verify the package builds and type-checks**

Run (from `packages/otel`): `pnpm build && pnpm typecheck` (or the package's configured scripts — check `packages/otel/package.json` `scripts`).
Expected: build + typecheck PASS.

- [ ] **Step 3: Write the README "Export" section**

Append to `packages/otel/README.md` a section showing the wiring (the exporter is the same instance in both spots):

````markdown
## Exporting metrics + traces (OUT)

`OtelTraceContextProvider` reads trace context IN. `TelescopeOtelExporter`
pushes everything Telescope records OUT — **complete** metrics (pre-sampling) and
**sampled** spans (post-flush).

```ts
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import {
  OtelTraceContextProvider,
  TelescopeOtelExporter,
  TelescopeOtelMetricsModule,
} from '@dudousxd/nestjs-telescope-otel';

// One instance, registered in two places.
const otel = new TelescopeOtelExporter();

@Module({
  imports: [
    TelescopeModule.forRoot({
      traceContext: new OtelTraceContextProvider(), // IN
      extensions: [otel],                           // OUT (metrics + spans)
    }),
    TelescopeOtelMetricsModule.forExporter(otel),   // GET /metrics (Prometheus)
  ],
})
export class AppModule {}
```

- **Metrics** are mirrored into the OTel Meter (OTLP push when your app has an
  OTel SDK) AND exposed as a dependency-free Prometheus scrape at `/metrics`.
- **Spans** go through the OTel Tracer; point your SDK's OTLP exporter at Tempo/
  Jaeger. Without an OTel SDK, both degrade to no-op — the Prometheus scrape still
  works.
````

- [ ] **Step 4: Write `docs/observability.md` (the `emit()` story)**

```markdown
# Observability: get any library into Telescope (and Grafana) with one line

Telescope sees third-party libraries through dedicated watchers. For libraries
**you** own, you don't need a watcher — emit a diagnostics event and Telescope's
generic watcher records it, and the OTel exporter forwards it to Grafana as
`telescope_diagnostic_total{lib,event}`.

```ts
import { emit, getChannel } from '@dudousxd/nestjs-diagnostics';

const channel = getChannel('mylib', 'thing-happened');
export function doThing() {
  if (channel.hasSubscribers) {
    emit('mylib', 'thing-happened', { detail: 'value' });
  }
}
```

That's it — no watcher, no Telescope-specific code. When the OTel exporter is
installed, every `emit` shows up as a metric and (via the recorded entry) a span.
```

- [ ] **Step 5: Commit**

```bash
git add packages/otel/src/index.ts packages/otel/README.md docs/observability.md
git commit -m "docs(otel): document metrics/trace export + emit() onboarding"
```

---

## Self-Review

**Spec coverage:**
- Métricas completas pré-sampling → Tasks 1, 4 (the `onRecorded` tap + `observeRecord`; the "fires even while paused" test proves completeness). ✅
- Traces amostrados pós-flush → Tasks 3, 6 (`observeFlush` off the existing flush hook). ✅
- Mesmo pacote, dois taps → Task 4 + 6 (one `TelescopeOtelExporter`). ✅
- Prometheus `/metrics` (consistência com durable) → Task 5. ✅
- OTLP push via OTel API, degrada a no-op sem SDK → Task 4 (meter) + Task 6 (tracer); both default to global no-op providers. ✅
- Reusa o que o telescope já vê (watchers + diagnostics) → taps live in the Recorder/registry, source-agnostic (Tasks 1-3); the generic `diagnostic` type is mapped (Task 4). ✅
- Correlação cross-lib (mesmo traceId) → spans carry `entry.traceId` (Task 6 `entryToSpan`). ✅
- Erro nunca quebra app/Recorder → isolated try/catch in every tap (Tasks 1, 2, 6 via registry). ✅
- Documentar `emit()` (parte C) → Task 7. ✅
- YAGNI: no watcher migration, no pluggable render, no diagnostics-only export → none added. ✅

**Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N" — every code/test step shows real content. ✅

**Type consistency:** `TelescopeOtelExporter` (name `'otel-export'`), `mapInput`/`MetricStore`/`MetricSample`, `entryToSpan`/`SpanShape`, `TELESCOPE_OTEL_EXPORTER`, `TelescopeOtelMetricsModule.forExporter`, `onRecorded(input: RecordInput)`, `observeRecord`/`observeFlush`, `notifyRecord`/`notifyFlush` — names used consistently across tasks. ✅

**Open item flagged for execution (not a blocker):** the metric `content` field names (`c.connection`/`c.host`/`c.class`/`c.status`) are best-effort reads against each watcher's content shape; Task 4's implementer should confirm the real field names against `packages/core/src/entry/content.ts` and the relevant watcher, adjusting the `mapInput` reads (the tests pin the *contract*, the field source may need tweaking). Histogram buckets use OTel defaults; refine later if needed.
