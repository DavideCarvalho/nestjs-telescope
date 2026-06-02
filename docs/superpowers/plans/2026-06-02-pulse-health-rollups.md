# Pulse Health Rollups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `GET /telescope/api/pulse?window=1h` health-summary endpoint — per-type entry counts, slowest entries, top exceptions, and N+1 occurrences — aggregated from stored entries. This is the original "admin platform analytics" ask, generalized.

**Architecture:** Same proven shape as queue metrics: read entries over a time window from storage (paginate + scan cap), reduce in a pure function, expose on the unified `/telescope/api` surface. The windowed-read loop (currently inside `QueueMetricsService`) is extracted into a shared `collectEntriesInWindow` helper that both `QueueMetricsService` and the new `PulseService` use (DRY — one place for the termination guards). A pure `summarizePulse` reducer computes counts, slowest (by `durationMs`), top exceptions (grouped by `familyHash`), and N+1 occurrences (per-batch via the existing `detectNPlusOne`). Housed in **core** for consistency with queue metrics and a single unified API the future `-ui` consumes.

**Tech Stack:** TypeScript (ESM/NodeNext, strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess), NestJS 11, vitest, biome, pnpm+turbo, changesets. Core package only.

---

## File Structure

**Core (`packages/core/`):**
- `src/metrics/collect-window.ts` (new) — `collectEntriesInWindow(storage, baseQuery, opts)` extracted from `QueueMetricsService` (the paginate + scan-cap + termination-guard loop).
- `src/metrics/queue-metrics.service.ts` (modify) — delegate to `collectEntriesInWindow` (behavior-preserving; its tests are the guard).
- `src/pulse/pulse-summary.ts` (new) — pure reducer `summarizePulse` + `PulseSummary`/`SlowEntry`/`ExceptionGroup`/`NPlusOneOccurrence` types.
- `src/pulse/pulse.service.ts` (new) — `PulseService.getHealth(windowMs)` (fetch all-type window → reducer).
- `src/nest/telescope.controller.ts` (modify) — `GET pulse` endpoint.
- `src/nest/telescope.module.ts` (modify) — register `PulseService`.
- `src/index.ts` (modify) — export collect-window, pulse-summary, pulse.service.
- Co-located `*.spec.ts` for collect-window, pulse-summary, pulse.service, and the controller endpoint.

---

## Task 1: Extract `collectEntriesInWindow` (shared windowed reader)

**Files:**
- Create: `packages/core/src/metrics/collect-window.ts`
- Modify: `packages/core/src/metrics/queue-metrics.service.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/metrics/collect-window.spec.ts`

- [ ] **Step 1: Write the failing test** — `packages/core/src/metrics/collect-window.spec.ts`:

```ts
// packages/core/src/metrics/collect-window.spec.ts
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { collectEntriesInWindow } from './collect-window.js';

function entry(type: string, createdAt: Date): Entry {
  return {
    id: `${type}-${Math.random()}`,
    batchId: 'b',
    type,
    familyHash: null,
    content: {},
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'i',
    createdAt,
  };
}

describe('collectEntriesInWindow', () => {
  it('paginates across pages and returns all matching entries', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    await storage.store(Array.from({ length: 1200 }, (_, i) => entry('query', new Date(now - i * 10))));
    const result = await collectEntriesInWindow(storage, { after: new Date(now - 3_600_000) });
    expect(result.entries).toHaveLength(1200);
    expect(result.scanned).toBe(1200);
    expect(result.truncated).toBe(false);
  });

  it('passes the base query through (type filter)', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    await storage.store([entry('query', new Date(now - 1000)), entry('request', new Date(now - 1000))]);
    const result = await collectEntriesInWindow(storage, { type: 'query', after: new Date(now - 3_600_000) });
    expect(result.scanned).toBe(1);
    expect(result.entries[0]!.type).toBe('query');
  });

  it('caps the scan and flags truncation, keeping the newest entries', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    await storage.store(Array.from({ length: 5 }, (_, i) => entry('query', new Date(now - i * 10))));
    const result = await collectEntriesInWindow(storage, { after: new Date(now - 3_600_000) }, { scanCap: 3 });
    expect(result.truncated).toBe(true);
    expect(result.scanned).toBe(3);
    expect(result.entries).toHaveLength(3);
  });

  it('terminates when a store returns an empty page with a non-null cursor', async () => {
    const hostile: StorageProvider = {
      get: async () => ({ data: [], nextCursor: 'never-null' }),
      store: async () => {},
      update: async () => {},
      find: async () => null,
      batch: async () => [],
      tags: async () => [],
      prune: async () => 0,
      clear: async () => {},
    };
    const result = await collectEntriesInWindow(hostile, { after: new Date() });
    expect(result.scanned).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('terminates when the cursor does not advance', async () => {
    const stuck: StorageProvider = {
      get: async () => ({ data: [entry('query', new Date())], nextCursor: 'stuck' }),
      store: async () => {},
      update: async () => {},
      find: async () => null,
      batch: async () => [],
      tags: async () => [],
      prune: async () => 0,
      clear: async () => {},
    };
    const result = await collectEntriesInWindow(stuck, { after: new Date() });
    expect(result.scanned).toBe(2);
  });
});
```

- [ ] **Step 2: Run, verify FAIL:** `pnpm --filter @dudousxd/nestjs-telescope test -- collect-window`

- [ ] **Step 3: Create `packages/core/src/metrics/collect-window.ts`** (move the loop verbatim from `queue-metrics.service.ts`):

```ts
// packages/core/src/metrics/collect-window.ts
import type { Entry } from '../entry/entry.js';
import type { EntryQuery, StorageProvider } from '../storage/storage-provider.js';

/** Entries fetched per storage page (default). */
export const DEFAULT_PAGE_SIZE = 500;
/** Safety cap on entries scanned per request; surfaced via `truncated` (default). */
export const DEFAULT_SCAN_CAP = 50_000;

export interface WindowReadOptions {
  pageSize?: number;
  scanCap?: number;
}

export interface WindowReadResult {
  entries: Entry[];
  /** Number of entries returned (<= scanCap). */
  scanned: number;
  /** True if the scan hit the cap (older entries in the window were not read). */
  truncated: boolean;
}

/** Page through `storage.get` for all entries matching `baseQuery`, newest-first,
 *  bounded by `scanCap`. Terminates safely even against a non-compliant store:
 *  an empty page or a non-advancing cursor ends the scan (the cap alone cannot
 *  catch an empty-page-with-cursor loop, since `entries` would never grow). */
export async function collectEntriesInWindow(
  storage: StorageProvider,
  baseQuery: Omit<EntryQuery, 'cursor' | 'limit'>,
  options: WindowReadOptions = {},
): Promise<WindowReadResult> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const scanCap = options.scanCap ?? DEFAULT_SCAN_CAP;

  const entries: Entry[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (;;) {
    const query: EntryQuery = {
      ...baseQuery,
      limit: pageSize,
      ...(cursor !== undefined ? { cursor } : {}),
    };
    const page = await storage.get(query);
    if (page.data.length === 0) break;
    entries.push(...page.data);
    if (entries.length >= scanCap) {
      truncated = true;
      break;
    }
    if (page.nextCursor === null || page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  }

  return {
    entries: entries.slice(0, scanCap),
    scanned: Math.min(entries.length, scanCap),
    truncated,
  };
}
```

- [ ] **Step 4: Refactor `queue-metrics.service.ts` to delegate.** READ it first. Replace the inline pagination loop in `getQueueMetrics` with a call to `collectEntriesInWindow`, keeping the window math, the `windowMs` validation, and the injectable `pageSize`/`scanCap`. The method body becomes:

```ts
  async getQueueMetrics(windowMs: number): Promise<QueueMetricsResult> {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError(`windowMs must be a positive, finite number (got ${windowMs}).`);
    }
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - windowMs);

    const { entries, scanned, truncated } = await collectEntriesInWindow(
      this.storage,
      { type: 'job', after: windowStart },
      { pageSize: this.pageSize, scanCap: this.scanCap },
    );

    const report = aggregateQueueMetrics(entries, windowStart, windowEnd);
    return { ...report, scanned, truncated };
  }
```

Add `import { collectEntriesInWindow } from './collect-window.js';`. Remove the now-unused `EntryQuery`/`Entry` imports IF they're no longer referenced (check — `Entry` may no longer be needed; `EntryQuery` likely not). Keep the local `DEFAULT_PAGE_SIZE`/`DEFAULT_SCAN_CAP` consts in the service OR switch to importing them from collect-window — either is fine; if you keep the service's own consts, that's acceptable (they're the injectable defaults). Do NOT change the constructor/options or the `QueueMetricsResult` shape.

- [ ] **Step 5: Export from index.** In `packages/core/src/index.ts` add:
```ts
export * from './metrics/collect-window.js';
```

- [ ] **Step 6: Verify (the existing QueueMetricsService specs are the regression guard for the extraction):**
- `pnpm --filter @dudousxd/nestjs-telescope test -- collect-window` → 5 pass
- `pnpm --filter @dudousxd/nestjs-telescope test -- queue-metrics.service` → still 7 pass (behavior preserved)
- `pnpm --filter @dudousxd/nestjs-telescope test` → full core suite green
- `pnpm --filter @dudousxd/nestjs-telescope typecheck` → clean
- `pnpm lint` → clean

- [ ] **Step 7: Commit**
```bash
git add packages/core/src/metrics/collect-window.ts packages/core/src/metrics/collect-window.spec.ts packages/core/src/metrics/queue-metrics.service.ts packages/core/src/index.ts
git commit -m "refactor(core): extract collectEntriesInWindow shared by metrics + pulse"
```

---

## Task 2: Pure `summarizePulse` reducer

**Files:**
- Create: `packages/core/src/pulse/pulse-summary.ts`
- Test: `packages/core/src/pulse/pulse-summary.spec.ts`

- [ ] **Step 1: Write the failing test** — `packages/core/src/pulse/pulse-summary.spec.ts`:

```ts
// packages/core/src/pulse/pulse-summary.spec.ts
import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { summarizePulse } from './pulse-summary.js';

function entry(partial: Partial<Entry> & { type: string }): Entry {
  return {
    id: `e-${Math.random()}`,
    batchId: 'b',
    type: partial.type,
    familyHash: partial.familyHash ?? null,
    content: partial.content ?? {},
    tags: [],
    sequence: 0,
    durationMs: partial.durationMs ?? null,
    origin: 'http',
    instanceId: 'i',
    createdAt: partial.createdAt ?? new Date('2026-06-02T12:00:00Z'),
    ...(partial.batchId ? { batchId: partial.batchId } : {}),
  };
}

const start = new Date('2026-06-02T11:00:00Z');
const end = new Date('2026-06-02T12:00:00Z');
const opts = { topN: 5, nPlusOneThreshold: 5 };

describe('summarizePulse', () => {
  it('counts entries per type', () => {
    const summary = summarizePulse(
      [entry({ type: 'request' }), entry({ type: 'query' }), entry({ type: 'query' })],
      start,
      end,
      opts,
    );
    expect(summary.counts).toEqual({ request: 1, query: 2 });
  });

  it('ranks slowest entries by duration with a type-aware label', () => {
    const summary = summarizePulse(
      [
        entry({ type: 'request', durationMs: 50, content: { method: 'GET', uri: '/a' } }),
        entry({ type: 'query', durationMs: 300, content: { sql: 'select 1' } }),
        entry({ type: 'job', durationMs: 100, content: { queue: 'mail', name: 'send' } }),
        entry({ type: 'request', durationMs: null, content: { uri: '/no-duration' } }),
      ],
      start,
      end,
      opts,
    );
    expect(summary.slowest.map((s) => s.durationMs)).toEqual([300, 100, 50]); // null excluded, desc
    expect(summary.slowest[0]!.label).toBe('select 1');
    expect(summary.slowest[1]!.label).toBe('mail:send');
    expect(summary.slowest[2]!.label).toBe('GET /a');
  });

  it('groups exceptions by familyHash with counts and last-seen', () => {
    const summary = summarizePulse(
      [
        entry({
          type: 'exception',
          familyHash: 'Error:boom',
          content: { class: 'Error', message: 'boom' },
          createdAt: new Date('2026-06-02T11:10:00Z'),
        }),
        entry({
          type: 'exception',
          familyHash: 'Error:boom',
          content: { class: 'Error', message: 'boom' },
          createdAt: new Date('2026-06-02T11:50:00Z'),
        }),
        entry({
          type: 'exception',
          familyHash: 'TypeError:nope',
          content: { class: 'TypeError', message: 'nope' },
          createdAt: new Date('2026-06-02T11:20:00Z'),
        }),
      ],
      start,
      end,
      opts,
    );
    expect(summary.topExceptions[0]).toMatchObject({
      familyHash: 'Error:boom',
      class: 'Error',
      message: 'boom',
      count: 2,
      lastSeen: '2026-06-02T11:50:00.000Z',
    });
    expect(summary.topExceptions[1]!.count).toBe(1);
  });

  it('detects N+1 per batch (same query template >= threshold times in one batch)', () => {
    const queries = Array.from({ length: 6 }, () =>
      entry({ type: 'query', batchId: 'req-1', familyHash: 'q:findUser', content: { sql: 'select * from users where id = ?' } }),
    );
    // A different batch with only 2 of the same template must NOT trigger.
    const other = Array.from({ length: 2 }, () =>
      entry({ type: 'query', batchId: 'req-2', familyHash: 'q:findUser', content: { sql: 'select * from users where id = ?' } }),
    );
    const summary = summarizePulse([...queries, ...other], start, end, opts);
    expect(summary.nPlusOne).toHaveLength(1);
    expect(summary.nPlusOne[0]).toMatchObject({ batchId: 'req-1', familyHash: 'q:findUser', count: 6 });
  });

  it('respects topN for slowest and exceptions', () => {
    const slow = Array.from({ length: 8 }, (_, i) => entry({ type: 'query', durationMs: i + 1, content: { sql: `q${i}` } }));
    const summary = summarizePulse(slow, start, end, { topN: 3, nPlusOneThreshold: 5 });
    expect(summary.slowest).toHaveLength(3);
    expect(summary.slowest.map((s) => s.durationMs)).toEqual([8, 7, 6]);
  });

  it('sets window fields', () => {
    const summary = summarizePulse([], start, end, opts);
    expect(summary.windowStart).toBe('2026-06-02T11:00:00.000Z');
    expect(summary.windowMs).toBe(3_600_000);
    expect(summary.counts).toEqual({});
    expect(summary.slowest).toEqual([]);
    expect(summary.topExceptions).toEqual([]);
    expect(summary.nPlusOne).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify FAIL:** `pnpm --filter @dudousxd/nestjs-telescope test -- pulse-summary`

- [ ] **Step 3: Implement `packages/core/src/pulse/pulse-summary.ts`:**

```ts
// packages/core/src/pulse/pulse-summary.ts
import { EntryType, type Entry } from '../entry/entry.js';
import { detectNPlusOne } from '../query/n-plus-one.js';

export interface SlowEntry {
  id: string;
  type: string;
  durationMs: number;
  label: string;
  batchId: string;
}

export interface ExceptionGroup {
  familyHash: string;
  class: string;
  message: string;
  count: number;
  lastSeen: string;
}

export interface NPlusOneOccurrence {
  batchId: string;
  familyHash: string;
  count: number;
  sql: string;
}

export interface PulseSummary {
  windowStart: string;
  windowEnd: string;
  windowMs: number;
  /** Entry count per type. */
  counts: Record<string, number>;
  /** Slowest entries by `durationMs`, descending. */
  slowest: SlowEntry[];
  /** Exception groups (by familyHash), most frequent first. */
  topExceptions: ExceptionGroup[];
  /** N+1 occurrences within a single batch, most repetitions first. */
  nPlusOne: NPlusOneOccurrence[];
}

export interface PulseOptions {
  topN: number;
  nPlusOneThreshold: number;
}

function asRecord(content: unknown): Record<string, unknown> | null {
  return typeof content === 'object' && content !== null ? (content as Record<string, unknown>) : null;
}

/** A human label for a slow entry, derived from its content by type. */
function labelFor(entry: Entry): string {
  const record = asRecord(entry.content);
  if (record === null) return entry.type;
  if (typeof record.uri === 'string') {
    return typeof record.method === 'string' ? `${record.method} ${record.uri}` : record.uri;
  }
  if (typeof record.sql === 'string') return record.sql;
  if (typeof record.queue === 'string' && typeof record.name === 'string') {
    return `${record.queue}:${record.name}`;
  }
  return entry.type;
}

interface ExceptionAccumulator {
  class: string;
  message: string;
  count: number;
  lastSeen: Date;
}

/** Summarize stored entries into a health snapshot: per-type counts, slowest
 *  entries, top exceptions, and per-batch N+1 occurrences. Pure: callers fetch
 *  the windowed entries. */
export function summarizePulse(
  entries: Entry[],
  windowStart: Date,
  windowEnd: Date,
  options: PulseOptions,
): PulseSummary {
  const counts: Record<string, number> = {};
  const slowCandidates: SlowEntry[] = [];
  const exceptionGroups = new Map<string, ExceptionAccumulator>();
  const batches = new Map<string, Entry[]>();

  for (const entry of entries) {
    counts[entry.type] = (counts[entry.type] ?? 0) + 1;

    if (typeof entry.durationMs === 'number') {
      slowCandidates.push({
        id: entry.id,
        type: entry.type,
        durationMs: entry.durationMs,
        label: labelFor(entry),
        batchId: entry.batchId,
      });
    }

    if (entry.type === EntryType.Exception && entry.familyHash !== null) {
      const record = asRecord(entry.content);
      const existing = exceptionGroups.get(entry.familyHash);
      if (existing) {
        existing.count += 1;
        if (entry.createdAt > existing.lastSeen) existing.lastSeen = entry.createdAt;
      } else {
        exceptionGroups.set(entry.familyHash, {
          class: typeof record?.class === 'string' ? record.class : 'Error',
          message: typeof record?.message === 'string' ? record.message : '',
          count: 1,
          lastSeen: entry.createdAt,
        });
      }
    }

    const batch = batches.get(entry.batchId);
    if (batch) batch.push(entry);
    else batches.set(entry.batchId, [entry]);
  }

  const slowest = slowCandidates
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, options.topN);

  const topExceptions = [...exceptionGroups.entries()]
    .map(([familyHash, group]) => ({
      familyHash,
      class: group.class,
      message: group.message,
      count: group.count,
      lastSeen: group.lastSeen.toISOString(),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, options.topN);

  const nPlusOne: NPlusOneOccurrence[] = [];
  for (const [batchId, batchEntries] of batches) {
    for (const insight of detectNPlusOne(batchEntries, options.nPlusOneThreshold)) {
      nPlusOne.push({ batchId, familyHash: insight.familyHash, count: insight.count, sql: insight.sql });
    }
  }
  nPlusOne.sort((a, b) => b.count - a.count);

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    windowMs: Math.max(0, windowEnd.getTime() - windowStart.getTime()),
    counts,
    slowest,
    topExceptions,
    nPlusOne: nPlusOne.slice(0, options.topN),
  };
}
```

- [ ] **Step 4: Run, verify PASS + typecheck:**
- `pnpm --filter @dudousxd/nestjs-telescope test -- pulse-summary` → 7 pass
- `pnpm --filter @dudousxd/nestjs-telescope typecheck`

- [ ] **Step 5: Commit**
```bash
git add packages/core/src/pulse/pulse-summary.ts packages/core/src/pulse/pulse-summary.spec.ts
git commit -m "feat(core): add pure summarizePulse reducer (counts, slowest, exceptions, N+1)"
```

---

## Task 3: `PulseService`

**Files:**
- Create: `packages/core/src/pulse/pulse.service.ts`
- Modify: `packages/core/src/nest/telescope.module.ts` (register provider)
- Modify: `packages/core/src/index.ts` (export)
- Test: `packages/core/src/pulse/pulse.service.spec.ts`

- [ ] **Step 1: Write the failing test** — `packages/core/src/pulse/pulse.service.spec.ts`:

```ts
// packages/core/src/pulse/pulse.service.spec.ts
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { PulseService } from './pulse.service.js';

function entry(type: string, content: unknown, durationMs: number | null, createdAt: Date): Entry {
  return {
    id: `e-${Math.random()}`,
    batchId: 'b',
    type,
    familyHash: type === 'exception' ? 'Error:boom' : null,
    content,
    tags: [],
    sequence: 0,
    durationMs,
    origin: 'http',
    instanceId: 'i',
    createdAt,
  };
}

describe('PulseService', () => {
  it('summarizes entries within the window from storage', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    await storage.store([
      entry('query', { sql: 'select 1' }, 300, new Date(now - 60_000)),
      entry('request', { uri: '/a', method: 'GET' }, 50, new Date(now - 60_000)),
      entry('exception', { class: 'Error', message: 'boom' }, null, new Date(now - 60_000)),
    ]);
    const service = new PulseService(storage);

    const report = await service.getHealth(3_600_000);

    expect(report.counts).toMatchObject({ query: 1, request: 1, exception: 1 });
    expect(report.slowest[0]!.durationMs).toBe(300);
    expect(report.topExceptions[0]!.count).toBe(1);
    expect(report.scanned).toBe(3);
    expect(report.truncated).toBe(false);
  });

  it('excludes entries older than the window', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    await storage.store([
      entry('query', { sql: 'a' }, 10, new Date(now - 30_000)),
      entry('query', { sql: 'b' }, 10, new Date(now - 600_000)),
    ]);
    const report = await new PulseService(storage).getHealth(60_000);
    expect(report.scanned).toBe(1);
  });

  it('rejects a non-positive window', async () => {
    const service = new PulseService(new InMemoryStorageProvider());
    await expect(service.getHealth(0)).rejects.toBeInstanceOf(RangeError);
    await expect(service.getHealth(-1)).rejects.toBeInstanceOf(RangeError);
  });
});
```

- [ ] **Step 2: Run, verify FAIL:** `pnpm --filter @dudousxd/nestjs-telescope test -- pulse.service`

- [ ] **Step 3: Implement `packages/core/src/pulse/pulse.service.ts`:**

```ts
// packages/core/src/pulse/pulse.service.ts
import { Inject, Injectable, Optional } from '@nestjs/common';
import { collectEntriesInWindow } from '../metrics/collect-window.js';
import { TELESCOPE_STORAGE } from '../nest/telescope.options.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { type PulseSummary, summarizePulse } from './pulse-summary.js';

const DEFAULT_TOP_N = 5;
const DEFAULT_N_PLUS_ONE_THRESHOLD = 5;

export interface PulseServiceOptions {
  pageSize?: number;
  scanCap?: number;
  /** How many slowest entries / exception groups / N+1 occurrences to return. Default 5. */
  topN?: number;
  /** Min repetitions of one query template in a batch to flag N+1. Default 5. */
  nPlusOneThreshold?: number;
}

export interface PulseResult extends PulseSummary {
  scanned: number;
  truncated: boolean;
}

/** Computes a health snapshot by aggregating stored entries over a time window.
 *  Reads the store (source of truth) on demand — no live counters. */
@Injectable()
export class PulseService {
  private readonly pageSize: number | undefined;
  private readonly scanCap: number | undefined;
  private readonly topN: number;
  private readonly nPlusOneThreshold: number;

  constructor(
    @Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider,
    @Optional() options?: PulseServiceOptions,
  ) {
    this.pageSize = options?.pageSize;
    this.scanCap = options?.scanCap;
    this.topN = options?.topN ?? DEFAULT_TOP_N;
    this.nPlusOneThreshold = options?.nPlusOneThreshold ?? DEFAULT_N_PLUS_ONE_THRESHOLD;
  }

  async getHealth(windowMs: number): Promise<PulseResult> {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError(`windowMs must be a positive, finite number (got ${windowMs}).`);
    }
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - windowMs);

    const { entries, scanned, truncated } = await collectEntriesInWindow(
      this.storage,
      { after: windowStart },
      {
        ...(this.pageSize !== undefined ? { pageSize: this.pageSize } : {}),
        ...(this.scanCap !== undefined ? { scanCap: this.scanCap } : {}),
      },
    );

    const summary = summarizePulse(entries, windowStart, windowEnd, {
      topN: this.topN,
      nPlusOneThreshold: this.nPlusOneThreshold,
    });
    return { ...summary, scanned, truncated };
  }
}
```

- [ ] **Step 4: Register the provider.** In `packages/core/src/nest/telescope.module.ts`: add `import { PulseService } from '../pulse/pulse.service.js';`, add `PulseService,` to `SHARED_PROVIDERS` (after `QueueMetricsService`), and add `PulseService` to the `exports` arrays of BOTH `forRoot` and `forRootAsync` (so it becomes `[TelescopeService, TELESCOPE_STORAGE, QueueMetricsService, PulseService]`).

- [ ] **Step 5: Export from index.** In `packages/core/src/index.ts` add:
```ts
export * from './pulse/pulse-summary.js';
export * from './pulse/pulse.service.js';
```

- [ ] **Step 6: Verify**
- `pnpm --filter @dudousxd/nestjs-telescope test -- pulse.service` → 3 pass
- `pnpm --filter @dudousxd/nestjs-telescope test` → full core suite green
- `pnpm --filter @dudousxd/nestjs-telescope typecheck` → clean
- `pnpm lint` → clean

- [ ] **Step 7: Commit**
```bash
git add packages/core/src/pulse/pulse.service.ts packages/core/src/pulse/pulse.service.spec.ts packages/core/src/nest/telescope.module.ts packages/core/src/index.ts
git commit -m "feat(core): add PulseService (windowed health snapshot)"
```

---

## Task 4: `GET /telescope/api/pulse` endpoint

**Files:**
- Modify: `packages/core/src/nest/telescope.controller.ts`
- Test: `packages/core/src/nest/telescope.controller.pulse.spec.ts`

- [ ] **Step 1: Write the failing test** — `packages/core/src/nest/telescope.controller.pulse.spec.ts`:

```ts
// packages/core/src/nest/telescope.controller.pulse.spec.ts
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeModule } from './telescope.module.js';

function entry(type: string, content: unknown, durationMs: number | null): Entry {
  return {
    id: `e-${Math.random()}`,
    batchId: 'b',
    type,
    familyHash: type === 'exception' ? 'Error:boom' : null,
    content,
    tags: [],
    sequence: 0,
    durationMs,
    origin: 'http',
    instanceId: 'i',
    createdAt: new Date(),
  };
}

describe('GET /telescope/api/pulse', () => {
  let app: INestApplication;
  const storage = new InMemoryStorageProvider();

  beforeAll(async () => {
    await storage.store([
      entry('query', { sql: 'select 1' }, 300),
      entry('request', { uri: '/a', method: 'GET' }, 50),
      entry('exception', { class: 'Error', message: 'boom' }, null),
    ]);
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ enabled: true, authorizer: () => true, storage })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns a health summary for the default window', async () => {
    const res = await request(app.getHttpServer()).get('/telescope/api/pulse').expect(200);
    const body = res.body as { counts: Record<string, number>; slowest: Array<{ durationMs: number }>; scanned: number };
    expect(body.counts).toMatchObject({ query: 1, request: 1, exception: 1 });
    expect(body.slowest[0]!.durationMs).toBe(300);
    expect(body.scanned).toBe(3);
  });

  it('accepts a window query param', async () => {
    const res = await request(app.getHttpServer()).get('/telescope/api/pulse?window=15m').expect(200);
    expect((res.body as { windowMs: number }).windowMs).toBe(900_000);
  });

  it('rejects an unparseable window with 400', async () => {
    await request(app.getHttpServer()).get('/telescope/api/pulse?window=soon').expect(400);
  });

  it('rejects a non-positive window with 400', async () => {
    await request(app.getHttpServer()).get('/telescope/api/pulse?window=0s').expect(400);
  });
});
```

- [ ] **Step 2: Run, verify FAIL** (404): `pnpm --filter @dudousxd/nestjs-telescope test -- telescope.controller.pulse`

- [ ] **Step 3: Add the endpoint to `telescope.controller.ts`.** READ it first.
- Add imports:
```ts
import { PulseService, type PulseResult } from '../pulse/pulse.service.js';
```
- Add a constructor parameter:
```ts
    @Inject(PulseService) private readonly pulse: PulseService,
```
- Add the route (after `queues`, before `meta`). Reuse the same window-validation shape as `queues`:
```ts
  @Get('pulse')
  pulseHealth(@Query('window') window?: string): Promise<PulseResult> {
    let windowMs: number;
    try {
      windowMs = durationToMs(window ?? '1h');
    } catch {
      throw new BadRequestException(`Invalid window: ${window}`);
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new BadRequestException(`Window must be positive: ${window}`);
    }
    return this.pulse.getHealth(windowMs);
  }
```
(`durationToMs` and `BadRequestException` are already imported from Task 5 of the queue-metrics work; reuse them — do not duplicate imports.)

- [ ] **Step 4: Verify**
- `pnpm --filter @dudousxd/nestjs-telescope test -- telescope.controller.pulse` → 4 pass
- `pnpm --filter @dudousxd/nestjs-telescope test` → full core suite green
- `pnpm --filter @dudousxd/nestjs-telescope typecheck` → clean
- `pnpm lint` → clean

- [ ] **Step 5: Commit**
```bash
git add packages/core/src/nest/telescope.controller.ts packages/core/src/nest/telescope.controller.pulse.spec.ts
git commit -m "feat(core): expose GET /telescope/api/pulse health summary"
```

---

## Task 5: Docs + changeset + whole-repo verification

**Files:**
- Modify: `README.md` (root)
- Create: `.changeset/pulse-health.md`

- [ ] **Step 1: Document the endpoint in the root `README.md`.** After the queue-metrics paragraph (added previously, mentioning `GET /telescope/api/queues`), add:

```markdown
For an at-a-glance health snapshot, `GET /telescope/api/pulse?window=1h` returns
per-type entry counts, the slowest entries, the most frequent exceptions, and
N+1 query occurrences — all aggregated from captured entries.
```

- [ ] **Step 2: Write the changeset** `.changeset/pulse-health.md`:

```markdown
---
'@dudousxd/nestjs-telescope': minor
---

Add a pulse health endpoint. `GET /telescope/api/pulse?window=1h` returns a
health snapshot aggregated from captured entries: per-type counts, slowest
entries (by duration), top exceptions (grouped by family), and per-batch N+1
query occurrences (`PulseService` + `summarizePulse`). The windowed-read loop is
extracted into a shared `collectEntriesInWindow` used by both pulse and queue
metrics.
```

- [ ] **Step 3: Whole-repo build + test + lint**
```bash
pnpm build
pnpm test
pnpm lint
```
All green; biome clean.

- [ ] **Step 4: Commit**
```bash
git add README.md .changeset/pulse-health.md
git commit -m "docs: document pulse health endpoint and add changeset"
```

---

## Self-Review

**Spec coverage:**
- Per-type counts, slowest, top exceptions, N+1 → Task 2 reducer.
- Windowed read (shared, bounded, terminating) → Task 1 `collectEntriesInWindow` (reused by queue metrics too).
- On-demand service + endpoint on the unified API, guarded, with window validation → Tasks 3–4.

**Placeholder scan:** No TBDs; complete code throughout. Reducer is pure + fully unit-tested; service + endpoint have behavioral tests over the in-memory store. A combined "trends over time" view, per-route drill-down, and a `StorageProvider.aggregate*` SPI for large windows are intentionally out of scope (noted, not stubbed).

**Type consistency:** `PulseSummary` (windowStart/windowEnd/windowMs/counts/slowest/topExceptions/nPlusOne) is produced by `summarizePulse(entries, start, end, { topN, nPlusOneThreshold })` and extended by `PulseResult` (adds scanned/truncated) returned by `PulseService.getHealth(windowMs)` and the controller. `SlowEntry`/`ExceptionGroup`/`NPlusOneOccurrence` are used identically across reducer, service, and tests. `collectEntriesInWindow(storage, baseQuery, { pageSize?, scanCap? })` returns `{ entries, scanned, truncated }` and is consumed by both `PulseService` and the refactored `QueueMetricsService` (whose existing tests guard the extraction). N+1 reuses core's `detectNPlusOne(entries, threshold)` per batch; exceptions group by the interceptor's `familyHash` (`"name:message"`); slowest labels read `uri`/`sql`/`queue+name` defensively.

**Housing note:** Rollups live in core (not a separate `-pulse` package) for consistency with queue metrics, a single unified `/telescope/api`, and to avoid cross-package guard/DI friction. Extractable to a package later if a boundary is wanted; the future `-ui` consumes these endpoints either way.
