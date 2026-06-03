# Horizon Phase 1 — Backend Live-Queue Read — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a driver-agnostic `QueueManager` SPI + registry to core with READ endpoints for live queue state, and implement `BullMqQueueManager` so the dashboard can browse live BullMQ queues (counts + jobs + job detail). No mutations yet (Phase 2).

**Architecture:** Mirror the existing `Watcher` SPI: managers are passed via `TelescopeModule.forRoot({ queueManagers: [...] })`, `init(ctx)`'d at `onApplicationBootstrap` by a new `QueueManagerRegistry`, and surfaced through unified `/telescope/api/queues/live/*` read routes on `TelescopeController` (under the existing `TelescopeGuard`). `BullMqQueueManager` (in `-bullmq`) discovers `Queue` instances via `DiscoveryService` (duck-typed) or an explicit `queues` name list, and reads them through the BullMQ `Queue` API.

**Tech Stack:** NestJS 11, `@nestjs/core` `DiscoveryService`, `@nestjs/bullmq` (`getQueueToken`), `bullmq` (`Queue`/`Job` types, type-only), vitest, real-Redis `skipIf(!REDIS_URL)`.

Spec: `docs/superpowers/specs/2026-06-03-horizon-queue-management-design.md`.

---

## File Structure

- Create `packages/core/src/queue/queue-manager.ts` — SPI + all DTO types + `QueueManagerContext`.
- Create `packages/core/src/queue/queue-manager.registry.ts` — `QueueManagerRegistry` (init at bootstrap, lookup by driver).
- Modify `packages/core/src/nest/telescope.options.ts` — add `queueManagers?` option + `QUEUE_MANAGERS` token.
- Modify `packages/core/src/nest/telescope.module.ts` — register `QueueManagerRegistry` in `SHARED_PROVIDERS`.
- Modify `packages/core/src/nest/telescope.controller.ts` — add 4 read routes.
- Modify `packages/core/src/index.ts` — export the SPI/types + registry.
- Create `packages/bullmq/src/bull-mq-queue-manager.ts` — `BullMqQueueManager`.
- Create `packages/bullmq/src/queue-discovery.ts` — duck-typed `Queue` discovery helper.
- Tests: `queue-manager.registry.spec.ts`, controller route spec additions, `bull-mq-queue-manager.spec.ts` (mock) + `.integration.spec.ts` (real Redis).

---

## Task 1: Core `QueueManager` SPI + types

**Files:** Create `packages/core/src/queue/queue-manager.ts`; Modify `packages/core/src/index.ts`.

- [ ] **Step 1: Write the SPI file** (exact content)

```ts
// packages/core/src/queue/queue-manager.ts
import type { ModuleRef } from '@nestjs/core';
import type { ResolvedCoreConfig } from '../config/options.js';

export type QueueState = 'waiting' | 'active' | 'delayed' | 'failed' | 'completed' | 'paused';

export const QUEUE_STATES: readonly QueueState[] = [
  'waiting', 'active', 'delayed', 'failed', 'completed', 'paused',
];

export function isQueueState(value: unknown): value is QueueState {
  return typeof value === 'string' && (QUEUE_STATES as readonly string[]).includes(value);
}

export interface QueueCounts {
  waiting: number; active: number; delayed: number; failed: number; completed: number; paused: number;
}
export interface QueueSummary { driver: string; queue: string; counts: QueueCounts; isPaused: boolean; }
export interface QueueJob {
  id: string; name: string; state: QueueState;
  attemptsMade: number; maxAttempts: number | null;
  timestamp: number | null; processedOn: number | null; finishedOn: number | null;
  failedReason: string | null; progress: number | null;
}
export interface QueueJobDetail extends QueueJob {
  data: unknown; opts: unknown; stacktrace: string[] | null; returnValue: unknown;
}
export interface JobPage { jobs: QueueJob[]; nextCursor: string | null; total: number | null; }

/** Handed to each QueueManager at boot (mirrors WatcherContext). */
export interface QueueManagerContext {
  readonly moduleRef: ModuleRef;
  readonly config: ResolvedCoreConfig;
  /** Redact a job payload before it leaves the server (core redaction). */
  readonly redact: (value: unknown) => unknown;
}

export interface QueueManager {
  readonly driver: string;
  init(ctx: QueueManagerContext): void | Promise<void>;
  listQueues(): Promise<QueueSummary[]>;
  counts(queue: string): Promise<QueueCounts>;
  listJobs(queue: string, state: QueueState, page: { cursor?: string; limit?: number }): Promise<JobPage>;
  getJob(queue: string, id: string): Promise<QueueJobDetail | null>;
  // actions — Phase 2 (optional; presence advertises capability):
  retry?(queue: string, id: string): Promise<void>;
  remove?(queue: string, id: string): Promise<void>;
  promote?(queue: string, id: string): Promise<void>;
  retryAll?(queue: string, state: QueueState): Promise<number>;
  redrive?(queue: string): Promise<number>;
}
```

- [ ] **Step 2: Export from core index** — add to `packages/core/src/index.ts`:
```ts
export * from './queue/queue-manager.js';
export * from './queue/queue-manager.registry.js';
```
(The registry export will resolve after Task 2; if building this task alone, add the registry export in Task 2.)

- [ ] **Step 3: Typecheck** — `cd packages/core && pnpm typecheck`. Expected: clean (the registry export may error until Task 2 — add it then; for this task export only `queue-manager.js`).
- [ ] **Step 4: Commit** — `feat(core): add QueueManager SPI + live-queue DTO types`.

---

## Task 2: `QueueManagerRegistry` (registration lifecycle)

**Files:** Create `packages/core/src/queue/queue-manager.registry.ts`; Modify `telescope.options.ts`, `telescope.module.ts`.

- [ ] **Step 1: Options + token** — in `packages/core/src/nest/telescope.options.ts` add `import type { QueueManager } from '../queue/queue-manager.js';`, add to `TelescopeModuleOptions`:
```ts
  /** Live-queue managers (e.g. BullMqQueueManager). Each contributes a driver to /queues/live. */
  queueManagers?: QueueManager[];
```
and `export const QUEUE_MANAGERS = Symbol('QUEUE_MANAGERS');` (kept for future DI use; the registry reads `options.queueManagers` directly).

- [ ] **Step 2: Write the registry** (exact content)
```ts
// packages/core/src/queue/queue-manager.registry.ts
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { ResolvedCoreConfig } from '../config/options.js';
import { TELESCOPE_CONFIG, TELESCOPE_OPTIONS, type TelescopeModuleOptions } from '../nest/telescope.options.js';
import type { QueueManager, QueueManagerContext } from './queue-manager.js';

@Injectable()
export class QueueManagerRegistry implements OnApplicationBootstrap {
  private readonly logger = new Logger(QueueManagerRegistry.name);
  private readonly managers = new Map<string, QueueManager>();

  constructor(
    @Inject(TELESCOPE_OPTIONS) private readonly options: TelescopeModuleOptions,
    @Inject(TELESCOPE_CONFIG) private readonly config: ResolvedCoreConfig,
    private readonly moduleRef: ModuleRef,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.enabled) return;
    const ctx: QueueManagerContext = {
      moduleRef: this.moduleRef,
      config: this.config,
      redact: (value: unknown) => this.config.redact(value),
    };
    for (const manager of this.options.queueManagers ?? []) {
      try {
        await manager.init(ctx);
        this.managers.set(manager.driver, manager);
      } catch (error) {
        this.logger.error(`QueueManager "${manager.driver}" failed to init: ${(error as Error).message}`);
      }
    }
    if (this.managers.size > 0) {
      this.logger.log(`Telescope queue drivers: ${[...this.managers.keys()].join(', ')}`);
    }
  }

  drivers(): string[] { return [...this.managers.keys()]; }
  get(driver: string): QueueManager | undefined { return this.managers.get(driver); }
  all(): QueueManager[] { return [...this.managers.values()]; }
}
```
NOTE: confirm `ResolvedCoreConfig.redact` exists and is `(value: unknown) => unknown`. If the resolved config exposes redaction under a different name, adapt `ctx.redact` to call it. (Check `packages/core/src/config/options.ts` / `resolve-config.ts`.)

- [ ] **Step 3: Register in module** — in `telescope.module.ts`, import `QueueManagerRegistry` and add it to `SHARED_PROVIDERS`.
- [ ] **Step 4: Export** — ensure `export * from './queue/queue-manager.registry.js';` in core index.
- [ ] **Step 5: Test** — `packages/core/src/queue/queue-manager.registry.spec.ts`: construct the registry with a fake options object containing a stub manager (driver `'fake'`, `init` records the ctx, other methods resolve empty), a resolved config with `enabled:true` + `redact: v=>v`, and a fake `ModuleRef`. Call `onApplicationBootstrap()`; assert `init` was called with a ctx whose `redact` works, `drivers()` returns `['fake']`, `get('fake')` returns it, and a manager whose `init` throws is skipped (not in `drivers()`) without throwing. Also assert: when `config.enabled` is false, no manager is init'd.
- [ ] **Step 6: Run** — `cd packages/core && pnpm test queue-manager.registry && pnpm typecheck`. Expected: pass.
- [ ] **Step 7: Commit** — `feat(core): add QueueManagerRegistry + queueManagers option`.

---

## Task 3: Core read endpoints

**Files:** Modify `packages/core/src/nest/telescope.controller.ts`; Test: `telescope.controller.queues-live.spec.ts`.

- [ ] **Step 1: Inject the registry** — add `@Inject(QueueManagerRegistry) private readonly queueManagers: QueueManagerRegistry` to the controller constructor; import `QueueManagerRegistry`, `isQueueState`, and the types from `../queue/queue-manager.js`.

- [ ] **Step 2: Add routes** (exact content)
```ts
  @Get('queues/live')
  async liveQueues(): Promise<{ queues: QueueSummary[] }> {
    const all = await Promise.all(this.queueManagers.all().map((m) => m.listQueues()));
    return { queues: all.flat() };
  }

  @Get('queues/live/:driver/:queue/counts')
  liveCounts(@Param('driver') driver: string, @Param('queue') queue: string): Promise<QueueCounts> {
    return this.requireManager(driver).counts(queue);
  }

  @Get('queues/live/:driver/:queue/jobs')
  liveJobs(
    @Param('driver') driver: string,
    @Param('queue') queue: string,
    @Query('state') state?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<JobPage> {
    if (!isQueueState(state)) throw new BadRequestException(`Invalid state: ${state}`);
    const page = {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined && Number.isFinite(Number(limit)) ? { limit: Number(limit) } : {}),
    };
    return this.requireManager(driver).listJobs(queue, state, page);
  }

  @Get('queues/live/:driver/:queue/jobs/:id')
  liveJob(
    @Param('driver') driver: string,
    @Param('queue') queue: string,
    @Param('id') id: string,
  ): Promise<QueueJobDetail | null> {
    return this.requireManager(driver).getJob(queue, id);
  }

  private requireManager(driver: string): QueueManager {
    const manager = this.queueManagers.get(driver);
    if (!manager) throw new NotFoundException(`Unknown queue driver: ${driver}`);
    return manager;
  }
```
(Add `NotFoundException` to the `@nestjs/common` import.)

- [ ] **Step 3: Test** — `telescope.controller.queues-live.spec.ts`: build a Nest testing app with `TelescopeModule.forRoot({ authorizer: () => true, queueManagers: [fakeManager] })` where `fakeManager.driver='bull'` returns canned `listQueues`/`counts`/`listJobs`/`getJob`. Via supertest assert:
  - `GET /telescope/api/queues/live` → `{ queues: [...] }` with the fake summary.
  - `GET /telescope/api/queues/live/bull/q1/counts` → the canned counts.
  - `GET /telescope/api/queues/live/bull/q1/jobs?state=failed` → the canned page; `?state=bogus` → 400.
  - `GET /telescope/api/queues/live/nope/q1/counts` → 404.
  - `GET /telescope/api/queues/live/bull/q1/jobs/123` → the canned detail.
- [ ] **Step 4: Run** — `cd packages/core && pnpm test queues-live && pnpm typecheck && pnpm build`. Expected: pass.
- [ ] **Step 5: Commit** — `feat(core): add live-queue read endpoints (/queues/live/*)`.

---

## Task 4: `BullMqQueueManager` — discovery + reads

**Files:** Create `packages/bullmq/src/queue-discovery.ts`, `packages/bullmq/src/bull-mq-queue-manager.ts`; Modify `packages/bullmq/src/index.ts`.

- [ ] **Step 1: Queue discovery helper** — `queue-discovery.ts`. A BullMQ `Queue` is duck-typed: object with string `name` and functions `getJobCounts`, `getJobs`, `getJob`, `isPaused`. Provide:
```ts
// packages/bullmq/src/queue-discovery.ts
import type { DiscoveryService } from '@nestjs/core';

export interface QueueLike {
  name: string;
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
  getJobs(types: string | string[], start?: number, end?: number, asc?: boolean): Promise<unknown[]>;
  getJob(id: string): Promise<unknown>;
  isPaused(): Promise<boolean>;
}

export function isQueueLike(value: unknown): value is QueueLike {
  if (typeof value !== 'object' || value === null) return false;
  const q = value as Record<string, unknown>;
  return (
    typeof q.name === 'string' &&
    typeof q.getJobCounts === 'function' &&
    typeof q.getJobs === 'function' &&
    typeof q.getJob === 'function' &&
    typeof q.isPaused === 'function'
  );
}

/** Find all BullMQ Queue instances registered in the Nest container. */
export function discoverQueues(discovery: DiscoveryService): QueueLike[] {
  const found = new Map<string, QueueLike>();
  for (const wrapper of discovery.getProviders()) {
    const instance = wrapper.instance;
    if (isQueueLike(instance) && !found.has(instance.name)) {
      found.set(instance.name, instance);
    }
  }
  return [...found.values()];
}
```
(Type-only `bullmq` `Queue` is not imported; duck-typing avoids the dep and esbuild metadata issues.)

- [ ] **Step 2: The manager** — `bull-mq-queue-manager.ts`. Resolve `DiscoveryService` from `ctx.moduleRef` in `init()`; cache the queues by name. Map BullMQ jobs → DTOs; redact `data` via `ctx.redact`. Key code:
```ts
// packages/bullmq/src/bull-mq-queue-manager.ts
import type {
  JobPage, QueueCounts, QueueJob, QueueJobDetail, QueueManager,
  QueueManagerContext, QueueState, QueueSummary,
} from '@dudousxd/nestjs-telescope';
import { DiscoveryService } from '@nestjs/core';
import { discoverQueues, type QueueLike } from './queue-discovery.js';

// BullMQ getJobs() uses these list names; 'waiting' maps to 'wait'.
const STATE_TO_BULL: Record<QueueState, string> = {
  waiting: 'wait', active: 'active', delayed: 'delayed',
  failed: 'failed', completed: 'completed', paused: 'paused',
};
const DEFAULT_LIMIT = 50;

interface BullJobLike {
  id?: string | null; name?: string; data?: unknown; opts?: unknown;
  attemptsMade?: number; timestamp?: number; processedOn?: number; finishedOn?: number;
  failedReason?: string; stacktrace?: string[]; returnvalue?: unknown; progress?: number | object;
}

export class BullMqQueueManager implements QueueManager {
  readonly driver = 'bullmq';
  private queues = new Map<string, QueueLike>();
  private redact: (v: unknown) => unknown = (v) => v;

  /** @param queueNames optional explicit allow-list; default = auto-discover all. */
  constructor(private readonly queueNames?: string[]) {}

  init(ctx: QueueManagerContext): void {
    this.redact = ctx.redact;
    const discovery = ctx.moduleRef.get(DiscoveryService, { strict: false });
    for (const q of discoverQueues(discovery)) {
      if (!this.queueNames || this.queueNames.includes(q.name)) this.queues.set(q.name, q);
    }
  }

  private require(queue: string): QueueLike {
    const q = this.queues.get(queue);
    if (!q) throw new Error(`Unknown bullmq queue: ${queue}`);
    return q;
  }

  private async countsFor(q: QueueLike): Promise<QueueCounts> {
    const c = await q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed', 'paused');
    return {
      waiting: c.waiting ?? 0, active: c.active ?? 0, delayed: c.delayed ?? 0,
      failed: c.failed ?? 0, completed: c.completed ?? 0, paused: c.paused ?? 0,
    };
  }

  async listQueues(): Promise<QueueSummary[]> {
    return Promise.all([...this.queues.values()].map(async (q) => ({
      driver: this.driver, queue: q.name,
      counts: await this.countsFor(q), isPaused: await q.isPaused(),
    })));
  }

  counts(queue: string): Promise<QueueCounts> { return this.countsFor(this.require(queue)); }

  async listJobs(queue: string, state: QueueState, page: { cursor?: string; limit?: number }): Promise<JobPage> {
    const q = this.require(queue);
    const limit = page.limit && page.limit > 0 ? page.limit : DEFAULT_LIMIT;
    const start = page.cursor ? Math.max(0, Number.parseInt(page.cursor, 10) || 0) : 0;
    const raw = (await q.getJobs(STATE_TO_BULL[state], start, start + limit, false)) as BullJobLike[];
    const jobs = raw.slice(0, limit).map((j) => this.toJob(j, state));
    const nextCursor = raw.length > limit ? String(start + limit) : null;
    return { jobs, nextCursor, total: null };
  }

  async getJob(queue: string, id: string): Promise<QueueJobDetail | null> {
    const raw = (await this.require(queue).getJob(id)) as BullJobLike | undefined | null;
    if (!raw) return null;
    const base = this.toJob(raw, 'completed'); // state recomputed below is non-critical for detail
    return {
      ...base,
      data: this.redact(raw.data),
      opts: raw.opts ?? null,
      stacktrace: Array.isArray(raw.stacktrace) ? raw.stacktrace : null,
      returnValue: raw.returnvalue ?? null,
    };
  }

  private toJob(j: BullJobLike, state: QueueState): QueueJob {
    const maxAttempts =
      typeof (j.opts as { attempts?: number } | undefined)?.attempts === 'number'
        ? (j.opts as { attempts: number }).attempts : null;
    return {
      id: String(j.id ?? ''), name: j.name ?? '', state,
      attemptsMade: j.attemptsMade ?? 0, maxAttempts,
      timestamp: j.timestamp ?? null, processedOn: j.processedOn ?? null, finishedOn: j.finishedOn ?? null,
      failedReason: j.failedReason ?? null,
      progress: typeof j.progress === 'number' ? j.progress : null,
    };
  }
}
```
- [ ] **Step 3: Export** — add `export * from './bull-mq-queue-manager.js';` and `export * from './queue-discovery.js';` to `packages/bullmq/src/index.ts`.
- [ ] **Step 4: Unit test (mock, CI-safe)** — `bull-mq-queue-manager.spec.ts`: build a fake `ModuleRef` whose `get(DiscoveryService)` returns a stub `DiscoveryService` with `getProviders()` returning wrappers around two `QueueLike` stubs (`q1`, `q2`) with canned `getJobCounts`/`getJobs`/`getJob`/`isPaused`. `init(ctx)` with `redact = v => ({redacted:true})`. Assert: `listQueues()` returns both with mapped counts + isPaused; `counts('q1')` maps correctly; `listJobs('q1','failed',{limit:1})` maps a job (id/name/attempts/failedReason) and sets `nextCursor` when more exist; `getJob('q1','5')` redacts `data` (returns `{redacted:true}`) and exposes opts/stacktrace; unknown queue throws.
- [ ] **Step 5: Integration test (real Redis, skipIf)** — `bull-mq-queue-manager.integration.spec.ts`, mirror `bullmq-job.watcher.integration.spec.ts` bootstrap (`BullModule.forRoot` + `registerQueue('telescope-test')`, `TelescopeModule.forRoot({ authorizer: ()=>true, queueManagers:[new BullMqQueueManager()] })`). After init: `queue.add('greet',{hello:'world'})`; resolve the manager via the registry (`app.get(QueueManagerRegistry).get('bullmq')`); assert `listQueues()` includes `telescope-test`, `counts()` reflects ≥1 job, `listJobs('telescope-test','waiting'|'completed',{})` returns the job, `getJob()` returns its (redacted-or-passthrough) data. `describe.skipIf(!process.env.REDIS_URL)`. Obliterate the queue in afterAll.
- [ ] **Step 6: Run** — `cd packages/bullmq && pnpm test && pnpm typecheck && pnpm build`. Expected: unit green; integration green if `REDIS_URL` set, else skipped.
- [ ] **Step 7: Commit** — `feat(bullmq): add BullMqQueueManager (live queue reads via DiscoveryService)`.

---

## Task 5: Whole-repo gate + wire docs

- [ ] **Step 1** — `cd ~/personal/nestjs-telescope && pnpm -w build && pnpm -w test && pnpm -w lint`. Expected: build all green, tests pass (bullmq integration skipped without Redis), lint clean.
- [ ] **Step 2: Changeset** — add `.changeset/horizon-queue-read.md`: minor bump `@dudousxd/nestjs-telescope` + `@dudousxd/nestjs-telescope-bullmq`, summarizing the QueueManager SPI + live-queue read endpoints + BullMqQueueManager.
- [ ] **Step 3: README** — `packages/bullmq/README.md`: document `queueManagers: [new BullMqQueueManager()]` wiring + the `/telescope/api/queues/live/*` read endpoints (note: actions land in Phase 2; reads are under the existing authorizer).
- [ ] **Step 4: Commit** — `docs(bullmq): document live-queue reads + changeset`.

---

## Notes for the executor

- Confirm `ResolvedCoreConfig.redact` name/signature before Task 2 (grep `redact` in `packages/core/src/config/`). Adapt `ctx.redact` accordingly.
- `DiscoveryService` requires `DiscoveryModule` — core already imports it in `TelescopeModule` (used by watchers), so `ctx.moduleRef.get(DiscoveryService, { strict: false })` resolves.
- BullMQ `getJobCounts` returns a plain object keyed by state names; `getJobs(listName, start, end)` where `waiting`→`'wait'`. Verify exact list-name strings against the installed `bullmq` version during Task 4; adjust `STATE_TO_BULL` if needed (use context7 `/taskforcesh/bullmq` if unsure).
- No mutations in this phase — `retry/remove/promote/retryAll/redrive` stay unimplemented on `BullMqQueueManager` until Phase 2.
```
