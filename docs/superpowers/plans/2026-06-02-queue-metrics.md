# Horizon-Style Queue Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a headless queue-metrics capability — `GET /telescope/api/queues?window=1h` returning per-queue throughput, runtime + wait-time percentiles, and failure rate — computed by aggregating the `job` entries the BullMQ watcher already captures.

**Architecture:** Metrics are computed *from stored job entries* (the source of truth — multi-replica-safe, no live counters), on demand. A pure reducer (`aggregateQueueMetrics`) groups job entries by queue and computes stats; a `QueueMetricsService` fetches job entries over a time window (paginating `StorageProvider.get` with a scan cap) and calls the reducer; a new controller endpoint exposes it on the existing `/telescope/api` surface (so the future `-ui` hits one unified API). Wait-time (Horizon's signature metric) requires a small capture enrichment: the BullMQ watcher records `waitMs` (processedOn − enqueue) into the canonical `JobContent`. This is the queue-metrics slice; broader `-pulse` health rollups (N+1, slowest req/query, top exceptions) remain deferred.

**Tech Stack:** TypeScript (ESM/NodeNext, strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess), NestJS 11, vitest, biome, pnpm+turbo, changesets. Core package + a small enrichment to `packages/bullmq`.

---

## File Structure

**Core (`packages/core/`):**
- `src/config/parse-duration.ts` (new) — `durationToMs(value: number | string): number`, extracted from `resolve-config.ts` (DRY; reused for the `?window=` param).
- `src/config/resolve-config.ts` (modify) — import `durationToMs`, drop the local `toMs`.
- `src/entry/content.ts` (modify) — add `waitMs: number | null` to canonical `JobContent`.
- `src/metrics/queue-metrics.ts` (new) — pure reducer `aggregateQueueMetrics` + `QueueMetrics`/`QueueMetricsReport`/`DurationStats` types + private `stats`/`percentile`/`readJobContent`.
- `src/metrics/queue-metrics.service.ts` (new) — `QueueMetricsService` (fetch window + paginate + cap → reducer).
- `src/nest/telescope.controller.ts` (modify) — `GET queues` endpoint.
- `src/nest/telescope.module.ts` (modify) — register `QueueMetricsService` provider.
- `src/index.ts` (modify) — export the new metrics module + parse-duration.
- Co-located `*.spec.ts` for parse-duration, queue-metrics (reducer), queue-metrics.service, and the controller endpoint.

**bullmq (`packages/bullmq/`):**
- `src/job-content.ts` (modify) — `JobLike` gains `timestamp?`/`processedOn?`; `buildJobContent` computes `waitMs`.
- `src/job-content.spec.ts` (modify) — assert `waitMs`.

---

## Task 1: Extract a shared `durationToMs` util

**Files:**
- Create: `packages/core/src/config/parse-duration.ts`
- Modify: `packages/core/src/config/resolve-config.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/config/parse-duration.spec.ts`

- [ ] **Step 1: Write the failing test** — `packages/core/src/config/parse-duration.spec.ts`:

```ts
// packages/core/src/config/parse-duration.spec.ts
import { describe, expect, it } from 'vitest';
import { durationToMs } from './parse-duration.js';

describe('durationToMs', () => {
  it('passes through a number unchanged', () => {
    expect(durationToMs(1500)).toBe(1500);
  });

  it('parses unit suffixes', () => {
    expect(durationToMs('500ms')).toBe(500);
    expect(durationToMs('30s')).toBe(30_000);
    expect(durationToMs('15m')).toBe(900_000);
    expect(durationToMs('2h')).toBe(7_200_000);
    expect(durationToMs('1d')).toBe(86_400_000);
  });

  it('trims surrounding whitespace', () => {
    expect(durationToMs(' 1h ')).toBe(3_600_000);
  });

  it('throws on an invalid duration string', () => {
    expect(() => durationToMs('soon')).toThrow('Invalid duration: soon');
    expect(() => durationToMs('10x')).toThrow('Invalid duration: 10x');
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- parse-duration`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `packages/core/src/config/parse-duration.ts`** (move the logic verbatim from `resolve-config.ts`):

```ts
// packages/core/src/config/parse-duration.ts

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Convert a duration (raw ms number, or `<int><ms|s|m|h|d>` string) to ms.
 *  Throws on an unparseable string. */
export function durationToMs(duration: number | string): number {
  if (typeof duration === 'number') {
    return duration;
  }
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(duration.trim());
  if (!match) {
    throw new Error(`Invalid duration: ${duration}`);
  }
  const unit = match[2] as keyof typeof DURATION_UNITS;
  return Number(match[1]) * DURATION_UNITS[unit]!;
}
```

- [ ] **Step 4: Refactor `resolve-config.ts` to use it.** In `packages/core/src/config/resolve-config.ts`: delete the `DURATION_UNITS` constant and the `toMs` function; add `import { durationToMs } from './parse-duration.js';`; replace the single call `toMs(parsed.prune.after)` with `durationToMs(parsed.prune.after)`.

- [ ] **Step 5: Export from index.** In `packages/core/src/index.ts`, add near the other config exports:

```ts
export * from './config/parse-duration.js';
```

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- parse-duration` (PASS)
Run: `pnpm --filter @dudousxd/nestjs-telescope test` (full core suite still green — resolve-config specs unaffected)
Run: `pnpm --filter @dudousxd/nestjs-telescope typecheck`

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/config/parse-duration.ts packages/core/src/config/parse-duration.spec.ts packages/core/src/config/resolve-config.ts packages/core/src/index.ts
git commit -m "refactor(core): extract durationToMs into a shared, exported util"
```

---

## Task 2: Capture `waitMs` (core `JobContent` + BullMQ watcher)

**Files:**
- Modify: `packages/core/src/entry/content.ts`
- Modify: `packages/bullmq/src/job-content.ts`
- Modify: `packages/bullmq/src/job-content.spec.ts`

- [ ] **Step 1: Enrich core `JobContent`.** In `packages/core/src/entry/content.ts`, add a `waitMs` field to `JobContent` (place it after `maxAttempts`):

```ts
export interface JobContent {
  id: string | null;
  name: string;
  queue: string;
  payload: unknown;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  attempts: number;
  maxAttempts: number | null;
  waitMs: number | null;
  failureReason: string | null;
}
```

- [ ] **Step 2: Build core so bullmq sees the new field**

Run: `pnpm --filter @dudousxd/nestjs-telescope build`
(Then run the full core suite to confirm the additive field broke nothing: `pnpm --filter @dudousxd/nestjs-telescope test`.)

- [ ] **Step 3: Update the failing bullmq content test FIRST.** In `packages/bullmq/src/job-content.spec.ts`:

In the `baseJob` const, add timestamps:
```ts
  const baseJob = {
    id: 42,
    name: 'send-welcome-email',
    queueName: 'mail',
    attemptsMade: 1,
    opts: { attempts: 3 },
    data: { to: 'ada@example.com' },
    timestamp: 1000,
    processedOn: 1250,
  };
```

In the first test ('builds a completed job content conforming to the core JobContent shape'), add `waitMs: 250` to the expected `toEqual` object (between `maxAttempts: 3` and `failureReason: null`):
```ts
    expect(content).toEqual({
      id: '42',
      name: 'send-welcome-email',
      queue: 'mail',
      payload: { to: 'ada@example.com' },
      status: 'completed',
      attempts: 1,
      maxAttempts: 3,
      waitMs: 250,
      failureReason: null,
    });
```

In the 'defaults missing fields' test, add an assertion that `waitMs` is null when timestamps are absent:
```ts
    expect(content.waitMs).toBeNull();
```

Add one focused test for the wait computation right after the 'preserves falsy-but-valid id and attempts' test:
```ts
  it('computes waitMs from processedOn - timestamp, null when either is missing', () => {
    expect(buildJobContent({ timestamp: 1000, processedOn: 1700 }, 'completed', undefined, true).waitMs).toBe(700);
    expect(buildJobContent({ timestamp: 1000 }, 'completed', undefined, true).waitMs).toBeNull();
    expect(buildJobContent({ processedOn: 1700 }, 'completed', undefined, true).waitMs).toBeNull();
  });
```

- [ ] **Step 4: Run, verify the content tests FAIL** (waitMs missing):

Run: `pnpm --filter @dudousxd/nestjs-telescope-bullmq test -- job-content`
Expected: FAIL on the new/updated assertions.

- [ ] **Step 5: Implement in `packages/bullmq/src/job-content.ts`.** Add the two timestamp fields to `JobLike`:

```ts
export interface JobLike {
  id?: string | number;
  name?: string;
  queueName?: string;
  attemptsMade?: number;
  opts?: { attempts?: number };
  data?: unknown;
  /** Epoch ms when the job was enqueued (BullMQ `Job.timestamp`). */
  timestamp?: number;
  /** Epoch ms when the worker began processing (BullMQ `Job.processedOn`). */
  processedOn?: number;
}
```

Add a wait-time helper and include `waitMs` in the returned content:

```ts
function waitMsOf(job: JobLike): number | null {
  return typeof job.processedOn === 'number' && typeof job.timestamp === 'number'
    ? job.processedOn - job.timestamp
    : null;
}
```

In `buildJobContent`'s returned object, add `waitMs: waitMsOf(job),` right after `maxAttempts`:

```ts
  return {
    id: job.id != null ? String(job.id) : null,
    name: job.name ?? '',
    queue: job.queueName ?? '',
    payload: includeData ? (job.data ?? null) : null,
    status,
    attempts: typeof job.attemptsMade === 'number' ? job.attemptsMade : 0,
    maxAttempts: typeof job.opts?.attempts === 'number' ? job.opts.attempts : null,
    waitMs: waitMsOf(job),
    failureReason: status === 'failed' ? failureMessage(error) : null,
  };
```

- [ ] **Step 6: Run, verify PASS + typecheck**

Run: `pnpm --filter @dudousxd/nestjs-telescope-bullmq test -- job-content` (all pass)
Run: `pnpm --filter @dudousxd/nestjs-telescope-bullmq typecheck`

> Note: the BullMQ `Job` instance already carries `timestamp` and `processedOn`, and the watcher passes the real job straight through to `buildJobContent` via `toJobLike`, so no change to `bullmq-job.watcher.ts` is needed — the new fields flow through automatically. (The watcher's existing tests don't set these, so `waitMs` is null there, which is fine.)

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/entry/content.ts packages/bullmq/src/job-content.ts packages/bullmq/src/job-content.spec.ts
git commit -m "feat(bullmq): capture job waitMs (processedOn - enqueue) into JobContent"
```

---

## Task 3: Pure queue-metrics reducer

**Files:**
- Create: `packages/core/src/metrics/queue-metrics.ts`
- Test: `packages/core/src/metrics/queue-metrics.spec.ts`

- [ ] **Step 1: Write the failing test** — `packages/core/src/metrics/queue-metrics.spec.ts`:

```ts
// packages/core/src/metrics/queue-metrics.spec.ts
import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { aggregateQueueMetrics } from './queue-metrics.js';

// Minimal job-entry factory; only the fields the reducer reads matter.
function jobEntry(
  queue: string,
  status: 'completed' | 'failed',
  durationMs: number | null,
  waitMs: number | null,
): Entry {
  return {
    id: `${queue}-${Math.random()}`,
    batchId: 'b',
    type: 'job',
    familyHash: `${queue}:x`,
    content: { queue, status, waitMs },
    tags: [],
    sequence: 0,
    durationMs,
    origin: 'queue',
    instanceId: 'i',
    createdAt: new Date('2026-06-02T12:00:00Z'),
  };
}

const start = new Date('2026-06-02T11:00:00Z'); // 60-minute window
const end = new Date('2026-06-02T12:00:00Z');

describe('aggregateQueueMetrics', () => {
  it('groups by queue with counts, failure rate, and throughput', () => {
    const entries = [
      jobEntry('mail', 'completed', 100, 10),
      jobEntry('mail', 'completed', 300, 30),
      jobEntry('mail', 'failed', 200, 20),
      jobEntry('reports', 'completed', 1000, 0),
    ];
    const report = aggregateQueueMetrics(entries, start, end);

    expect(report.windowMs).toBe(3_600_000);
    expect(report.windowStart).toBe('2026-06-02T11:00:00.000Z');
    expect(report.queues.map((q) => q.queue)).toEqual(['mail', 'reports']); // sorted by total desc

    const mail = report.queues[0]!;
    expect(mail.total).toBe(3);
    expect(mail.completed).toBe(2);
    expect(mail.failed).toBe(1);
    expect(mail.failureRate).toBeCloseTo(1 / 3);
    expect(mail.throughputPerMinute).toBeCloseTo(3 / 60);
    expect(mail.runtimeMs).not.toBeNull();
    expect(mail.runtimeMs!.max).toBe(300);
    expect(mail.runtimeMs!.avg).toBe(200); // (100+300+200)/3
    expect(mail.waitMs!.max).toBe(30);
  });

  it('ignores non-job entries', () => {
    const request: Entry = { ...jobEntry('mail', 'completed', 100, 10), type: 'request' };
    const report = aggregateQueueMetrics([request, jobEntry('mail', 'completed', 50, 5)], start, end);
    expect(report.queues).toHaveLength(1);
    expect(report.queues[0]!.total).toBe(1);
  });

  it('reports null runtime/wait stats when no samples are present', () => {
    const report = aggregateQueueMetrics([jobEntry('mail', 'completed', null, null)], start, end);
    expect(report.queues[0]!.runtimeMs).toBeNull();
    expect(report.queues[0]!.waitMs).toBeNull();
  });

  it('buckets entries with a missing/empty queue under "unknown"', () => {
    const noQueue: Entry = { ...jobEntry('', 'completed', 100, 10), content: { status: 'completed' } };
    const report = aggregateQueueMetrics([noQueue], start, end);
    expect(report.queues[0]!.queue).toBe('unknown');
  });

  it('computes nearest-rank percentiles', () => {
    const entries = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((d) =>
      jobEntry('mail', 'completed', d, null),
    );
    const stats = aggregateQueueMetrics(entries, start, end).queues[0]!.runtimeMs!;
    expect(stats.p50).toBe(50); // ceil(0.5*10)=5 -> index 4 -> 50
    expect(stats.p95).toBe(100); // ceil(0.95*10)=10 -> index 9 -> 100
    expect(stats.max).toBe(100);
  });

  it('returns an empty queues list for no entries', () => {
    const report = aggregateQueueMetrics([], start, end);
    expect(report.queues).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify FAIL** (`aggregateQueueMetrics` not found):

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- queue-metrics.spec`

- [ ] **Step 3: Implement `packages/core/src/metrics/queue-metrics.ts`:**

```ts
// packages/core/src/metrics/queue-metrics.ts
import type { Entry } from '../entry/entry.js';

export interface DurationStats {
  avg: number;
  p50: number;
  p95: number;
  max: number;
}

export interface QueueMetrics {
  queue: string;
  total: number;
  completed: number;
  failed: number;
  /** failed / total, in [0, 1]. */
  failureRate: number;
  /** total jobs / window minutes. */
  throughputPerMinute: number;
  /** Processing-time stats (from `Entry.durationMs`); null when no samples. */
  runtimeMs: DurationStats | null;
  /** Queue-wait stats (from `JobContent.waitMs`); null when no samples. */
  waitMs: DurationStats | null;
}

export interface QueueMetricsReport {
  windowStart: string;
  windowEnd: string;
  windowMs: number;
  queues: QueueMetrics[];
}

interface JobView {
  queue: string;
  status: string | null;
  waitMs: number | null;
}

/** Defensively read the queue/status/waitMs we need off an entry's content. */
function readJob(content: unknown): JobView {
  if (typeof content !== 'object' || content === null) {
    return { queue: 'unknown', status: null, waitMs: null };
  }
  const record = content as Record<string, unknown>;
  const queue = typeof record.queue === 'string' && record.queue ? record.queue : 'unknown';
  return {
    queue,
    status: typeof record.status === 'string' ? record.status : null,
    waitMs: typeof record.waitMs === 'number' ? record.waitMs : null,
  };
}

/** Nearest-rank percentile of an ascending-sorted array. */
function percentile(sortedAscending: number[], fraction: number): number {
  if (sortedAscending.length === 0) return 0;
  const rank = Math.ceil(fraction * sortedAscending.length);
  const index = Math.min(sortedAscending.length, Math.max(1, rank)) - 1;
  return sortedAscending[index]!;
}

function statsOf(values: number[]): DurationStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    avg: sum / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1]!,
  };
}

interface QueueAccumulator {
  total: number;
  completed: number;
  failed: number;
  runtimes: number[];
  waits: number[];
}

/** Group `job` entries by queue and compute per-queue throughput, runtime/wait
 *  percentiles, and failure rate over the [windowStart, windowEnd] window.
 *  Non-job entries are ignored. Pure: callers fetch the entries. */
export function aggregateQueueMetrics(
  entries: Entry[],
  windowStart: Date,
  windowEnd: Date,
): QueueMetricsReport {
  const windowMs = Math.max(0, windowEnd.getTime() - windowStart.getTime());
  const windowMinutes = windowMs / 60_000;

  const groups = new Map<string, QueueAccumulator>();
  for (const entry of entries) {
    if (entry.type !== 'job') continue;
    const job = readJob(entry.content);
    let group = groups.get(job.queue);
    if (!group) {
      group = { total: 0, completed: 0, failed: 0, runtimes: [], waits: [] };
      groups.set(job.queue, group);
    }
    group.total += 1;
    if (job.status === 'failed') group.failed += 1;
    else if (job.status === 'completed') group.completed += 1;
    if (typeof entry.durationMs === 'number') group.runtimes.push(entry.durationMs);
    if (job.waitMs !== null) group.waits.push(job.waitMs);
  }

  const queues: QueueMetrics[] = [...groups.entries()]
    .map(([queue, group]) => ({
      queue,
      total: group.total,
      completed: group.completed,
      failed: group.failed,
      failureRate: group.total > 0 ? group.failed / group.total : 0,
      throughputPerMinute: windowMinutes > 0 ? group.total / windowMinutes : 0,
      runtimeMs: statsOf(group.runtimes),
      waitMs: statsOf(group.waits),
    }))
    .sort((a, b) => b.total - a.total || a.queue.localeCompare(b.queue));

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    windowMs,
    queues,
  };
}
```

- [ ] **Step 4: Run, verify PASS + typecheck**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- queue-metrics.spec`
Run: `pnpm --filter @dudousxd/nestjs-telescope typecheck`

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/metrics/queue-metrics.ts packages/core/src/metrics/queue-metrics.spec.ts
git commit -m "feat(core): add pure queue-metrics reducer (throughput, runtime/wait percentiles, failure rate)"
```

---

## Task 4: `QueueMetricsService` (fetch window + paginate + cap)

**Files:**
- Create: `packages/core/src/metrics/queue-metrics.service.ts`
- Modify: `packages/core/src/nest/telescope.module.ts` (register provider)
- Modify: `packages/core/src/index.ts` (export)
- Test: `packages/core/src/metrics/queue-metrics.service.spec.ts`

- [ ] **Step 1: Write the failing test** — `packages/core/src/metrics/queue-metrics.service.spec.ts`:

```ts
// packages/core/src/metrics/queue-metrics.service.spec.ts
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { QueueMetricsService } from './queue-metrics.service.js';

function jobEntry(queue: string, status: 'completed' | 'failed', createdAt: Date): Entry {
  return {
    id: `${queue}-${Math.random()}`,
    batchId: 'b',
    type: 'job',
    familyHash: `${queue}:x`,
    content: { queue, status, waitMs: 5 },
    tags: [],
    sequence: 0,
    durationMs: 100,
    origin: 'queue',
    instanceId: 'i',
    createdAt,
  };
}

describe('QueueMetricsService', () => {
  it('aggregates job entries within the window from storage', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    await storage.store([
      jobEntry('mail', 'completed', new Date(now - 60_000)),
      jobEntry('mail', 'failed', new Date(now - 120_000)),
      jobEntry('reports', 'completed', new Date(now - 30_000)),
    ]);
    const service = new QueueMetricsService(storage);

    const report = await service.getQueueMetrics(3_600_000); // 1h

    expect(report.queues.map((q) => q.queue)).toEqual(['mail', 'reports']);
    expect(report.queues.find((q) => q.queue === 'mail')!.total).toBe(2);
    expect(report.scanned).toBe(3);
    expect(report.truncated).toBe(false);
  });

  it('excludes entries older than the window', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    await storage.store([
      jobEntry('mail', 'completed', new Date(now - 30_000)), // in 1m window
      jobEntry('mail', 'completed', new Date(now - 600_000)), // outside 1m window
    ]);
    const service = new QueueMetricsService(storage);

    const report = await service.getQueueMetrics(60_000); // 1m
    expect(report.scanned).toBe(1);
    expect(report.queues[0]!.total).toBe(1);
  });

  it('paginates across multiple storage pages', async () => {
    const storage = new InMemoryStorageProvider();
    const now = Date.now();
    const entries = Array.from({ length: 1200 }, (_, i) =>
      jobEntry('mail', 'completed', new Date(now - i * 10)),
    );
    await storage.store(entries);
    const service = new QueueMetricsService(storage);

    const report = await service.getQueueMetrics(3_600_000);
    expect(report.scanned).toBe(1200); // more than one 500-entry page
    expect(report.queues[0]!.total).toBe(1200);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- queue-metrics.service`

- [ ] **Step 3: Implement `packages/core/src/metrics/queue-metrics.service.ts`:**

```ts
// packages/core/src/metrics/queue-metrics.service.ts
import { Inject, Injectable } from '@nestjs/common';
import type { Entry } from '../entry/entry.js';
import { TELESCOPE_STORAGE } from '../nest/telescope.options.js';
import type { EntryQuery, StorageProvider } from '../storage/storage-provider.js';
import { type QueueMetricsReport, aggregateQueueMetrics } from './queue-metrics.js';

/** Entries fetched per storage page. */
const PAGE_SIZE = 500;
/** Safety cap on entries scanned per request; surfaced via `truncated`. */
const SCAN_CAP = 50_000;

export interface QueueMetricsResult extends QueueMetricsReport {
  /** Number of job entries aggregated. */
  scanned: number;
  /** True if the scan hit `SCAN_CAP` (older jobs in the window were not counted). */
  truncated: boolean;
}

/** Computes queue metrics by aggregating stored `job` entries over a time
 *  window. Reads the store (source of truth) on demand — no live counters, so
 *  it is correct across restarts and replicas. */
@Injectable()
export class QueueMetricsService {
  constructor(@Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider) {}

  async getQueueMetrics(windowMs: number): Promise<QueueMetricsResult> {
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - windowMs);

    const entries: Entry[] = [];
    let cursor: string | undefined;
    let truncated = false;
    for (;;) {
      const query: EntryQuery = {
        type: 'job',
        after: windowStart,
        limit: PAGE_SIZE,
        ...(cursor !== undefined ? { cursor } : {}),
      };
      const page = await this.storage.get(query);
      entries.push(...page.data);
      if (entries.length >= SCAN_CAP) {
        truncated = true;
        break;
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    const scanned = Math.min(entries.length, SCAN_CAP);
    const report = aggregateQueueMetrics(entries.slice(0, SCAN_CAP), windowStart, windowEnd);
    return { ...report, scanned, truncated };
  }
}
```

- [ ] **Step 4: Register the provider.** In `packages/core/src/nest/telescope.module.ts`, import `QueueMetricsService` and add it to `SHARED_PROVIDERS`:

```ts
import { QueueMetricsService } from '../metrics/queue-metrics.service.js';
```
Add `QueueMetricsService,` to the `SHARED_PROVIDERS` array (e.g. after `TelescopePruner`). It's used by the controller (already in `controllers`), so no `exports` change is required, but ADD it to the module `exports` array too (both `forRoot` and `forRootAsync` export `[TelescopeService, TELESCOPE_STORAGE]`) → make it `[TelescopeService, TELESCOPE_STORAGE, QueueMetricsService]` so consumers/tests can resolve it.

- [ ] **Step 5: Export from index.** In `packages/core/src/index.ts`, add:

```ts
export * from './metrics/queue-metrics.js';
export * from './metrics/queue-metrics.service.js';
```

- [ ] **Step 6: Run tests + typecheck + full core suite**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- queue-metrics.service` (PASS)
Run: `pnpm --filter @dudousxd/nestjs-telescope test` (full suite green)
Run: `pnpm --filter @dudousxd/nestjs-telescope typecheck`

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/metrics/queue-metrics.service.ts packages/core/src/nest/telescope.module.ts packages/core/src/index.ts packages/core/src/metrics/queue-metrics.service.spec.ts
git commit -m "feat(core): add QueueMetricsService (window fetch + pagination + scan cap)"
```

---

## Task 5: `GET /telescope/api/queues` endpoint

**Files:**
- Modify: `packages/core/src/nest/telescope.controller.ts`
- Test: `packages/core/src/nest/telescope.controller.queues.spec.ts`

- [ ] **Step 1: Write the failing test** — `packages/core/src/nest/telescope.controller.queues.spec.ts`:

```ts
// packages/core/src/nest/telescope.controller.queues.spec.ts
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TELESCOPE_STORAGE } from './telescope.options.js';
import { TelescopeModule } from './telescope.module.js';

function jobEntry(queue: string): Entry {
  return {
    id: `${queue}-${Math.random()}`,
    batchId: 'b',
    type: 'job',
    familyHash: `${queue}:x`,
    content: { queue, status: 'completed', waitMs: 5 },
    tags: [],
    sequence: 0,
    durationMs: 100,
    origin: 'queue',
    instanceId: 'i',
    createdAt: new Date(),
  };
}

describe('GET /telescope/api/queues', () => {
  let app: INestApplication;
  const storage = new InMemoryStorageProvider();

  beforeAll(async () => {
    await storage.store([jobEntry('mail'), jobEntry('mail'), jobEntry('reports')]);
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ enabled: true, authorizer: () => true, storage })],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns per-queue metrics for the default window', async () => {
    const res = await request(app.getHttpServer()).get('/telescope/api/queues').expect(200);
    const body = res.body as { queues: Array<{ queue: string; total: number }>; scanned: number };
    expect(body.queues.map((q) => q.queue)).toEqual(['mail', 'reports']);
    expect(body.queues[0]!.total).toBe(2);
    expect(body.scanned).toBe(3);
  });

  it('accepts a window query param', async () => {
    const res = await request(app.getHttpServer()).get('/telescope/api/queues?window=15m').expect(200);
    expect((res.body as { windowMs: number }).windowMs).toBe(900_000);
  });

  it('rejects an invalid window with 400', async () => {
    await request(app.getHttpServer()).get('/telescope/api/queues?window=soon').expect(400);
  });
});
```

> If `TelescopeModule.forRoot` does not yet accept a `storage` option in its options type, it does — `TELESCOPE_STORAGE` falls back to `options.storage ?? new SqliteStorageProvider()` (see `telescope.module.ts`). Passing `storage` keeps the test on the in-memory store.

- [ ] **Step 2: Run, verify FAIL** (404 — no `queues` route):

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- telescope.controller.queues`

- [ ] **Step 3: Add the endpoint.** In `packages/core/src/nest/telescope.controller.ts`:

Add imports:
```ts
import { BadRequestException } from '@nestjs/common';
import { durationToMs } from '../config/parse-duration.js';
import { QueueMetricsService, type QueueMetricsResult } from '../metrics/queue-metrics.service.js';
```
(Merge `BadRequestException` into the existing `@nestjs/common` import line rather than adding a duplicate import.)

Inject the service in the constructor (add a third parameter):
```ts
  constructor(
    @Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider,
    @Inject(TelescopeService) private readonly service: TelescopeService,
    @Inject(QueueMetricsService) private readonly queueMetrics: QueueMetricsService,
  ) {}
```

Add the route (place it near the other `@Get` handlers, e.g. after `tags`):
```ts
  @Get('queues')
  queues(@Query('window') window?: string): Promise<QueueMetricsResult> {
    let windowMs: number;
    try {
      windowMs = durationToMs(window ?? '1h');
    } catch {
      throw new BadRequestException(`Invalid window: ${window}`);
    }
    return this.queueMetrics.getQueueMetrics(windowMs);
  }
```

- [ ] **Step 4: Run, verify PASS + typecheck + full suite**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- telescope.controller.queues` (3 pass)
Run: `pnpm --filter @dudousxd/nestjs-telescope test` (full suite green)
Run: `pnpm --filter @dudousxd/nestjs-telescope typecheck`

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/nest/telescope.controller.ts packages/core/src/nest/telescope.controller.queues.spec.ts
git commit -m "feat(core): expose GET /telescope/api/queues for queue metrics"
```

---

## Task 6: Docs + changeset + whole-repo verification

**Files:**
- Modify: `README.md` (root)
- Modify: `packages/bullmq/README.md`
- Create: `.changeset/queue-metrics.md`

- [ ] **Step 1: Document the endpoint in the root `README.md`.** Under the quick-start (after the line about `GET /telescope/api/entries`), add a short paragraph:

```markdown
For queue health, `GET /telescope/api/queues?window=1h` returns per-queue
throughput, runtime and wait-time percentiles, and failure rate aggregated from
captured job entries.
```

- [ ] **Step 2: Mention metrics in `packages/bullmq/README.md`.** After the paragraph describing job entries, add:

```markdown
With these entries captured, the core endpoint
`GET /telescope/api/queues?window=1h` reports per-queue throughput, runtime and
wait-time percentiles, and failure rate (wait time = `processedOn − enqueue`).
```

- [ ] **Step 3: Write the changeset** `.changeset/queue-metrics.md`:

```markdown
---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-bullmq': minor
---

Add Horizon-style queue metrics. A new `GET /telescope/api/queues?window=1h`
endpoint aggregates captured `job` entries into per-queue throughput, runtime
and wait-time percentiles, and failure rate (`QueueMetricsService` +
`aggregateQueueMetrics`). The BullMQ watcher now captures `waitMs`
(`processedOn − enqueue`) on each job, and the canonical `JobContent` gains a
`waitMs` field. `durationToMs` is extracted as a shared, exported util.
```

- [ ] **Step 4: Whole-repo build + test + lint**

Run: `pnpm build`
Run: `pnpm test`
Run: `pnpm lint`
Expected: all packages green; biome clean.

- [ ] **Step 5: Commit**

```bash
git add README.md packages/bullmq/README.md .changeset/queue-metrics.md
git commit -m "docs: document queue-metrics endpoint and add changeset"
```

---

## Self-Review

**Spec coverage:**
- Per-queue throughput, runtime + wait percentiles, failure rate → Task 3 reducer.
- Wait-time capture (Horizon signature metric) → Task 2 (`waitMs` in JobContent + watcher).
- Window selection (`?window=1h`) → Task 1 (`durationToMs`) + Task 5 endpoint.
- On-demand aggregation from the store with bounded scan → Task 4 (`QueueMetricsService`, `SCAN_CAP`/`truncated`, no silent truncation).
- Exposed on the unified `/telescope/api` surface, guarded → Task 5.

**Placeholder scan:** No TBDs; every step has complete code. The reducer is pure and fully unit-tested; the service and endpoint have behavioral tests over the in-memory store. Per-job-name breakdown and time-bucketed throughput series are intentionally out of scope (YAGNI for this slice; note it rather than stub it).

**Type consistency:** `QueueMetricsReport` (windowStart/windowEnd/windowMs/queues) is produced by `aggregateQueueMetrics` and extended by `QueueMetricsResult` (adds scanned/truncated) returned by `QueueMetricsService.getQueueMetrics(windowMs: number)` and the controller. `DurationStats` (avg/p50/p95/max) and `QueueMetrics` (queue/total/completed/failed/failureRate/throughputPerMinute/runtimeMs/waitMs) are used identically across reducer, service, and tests. `JobContent.waitMs` (core) is populated by `buildJobContent` (bullmq) and read by the reducer's `readJob`. `durationToMs` is the single shared parser (Task 1) used by both `resolve-config` and the controller.

**Aggregation-source note:** Metrics read stored entries (pruned, bounded) rather than live counters — correct and replica-safe for an observability tool, at the cost of scanning entries per request. The `SCAN_CAP` + `truncated` flag prevents unbounded work and surfaces truncation instead of silently undercounting. If a deployment needs larger windows efficiently, a future `StorageProvider.aggregateJobs` SPI method can back the same service without changing the API — out of scope here.
