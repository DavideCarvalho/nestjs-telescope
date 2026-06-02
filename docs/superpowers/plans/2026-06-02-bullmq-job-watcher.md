# BullMQ Job Watcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@dudousxd/nestjs-telescope-bullmq` — a Job watcher that captures every BullMQ job (name, queue, outcome, duration, attempts) AND correlates the queries/exceptions a job emits to that job's batch, by wrapping each `@nestjs/bullmq` processor's execution in a `'queue'`-origin ALS batch.

**Architecture:** The watcher implements the core `Watcher` SPI. At `register(ctx)` (which the registrar runs at `onApplicationBootstrap`) it uses NestJS `DiscoveryService` to find every `WorkerHost` provider and replaces its subclass-prototype `process(job, token)` method with a wrapper that runs the original inside `ctx.runInBatch('queue', ...)`, then records a `job` entry on completion/failure. This works because `@nestjs/bullmq` looks up `instance.process` **at call-time per job** (to support request-scoped processors), and jobs only run after bootstrap — so a prototype patch applied during `register()` always precedes the first job. This is genuinely runtime + in-process, unlike the MikroORM host-wired logger. Aggregate "Horizon-style" queue metrics (throughput, wait time) are explicitly **out of scope** here — they belong to a later `-pulse` rollup slice.

**Tech Stack:** TypeScript (ESM/NodeNext), NestJS 11, `@nestjs/bullmq` + `bullmq` (peer deps), `@nestjs/core` `DiscoveryService`, vitest, biome, pnpm+turbo, changesets. Mirrors the existing `packages/mikro-orm` package layout.

---

## File Structure

**New package `packages/bullmq/`:**
- `package.json` — package manifest (peers: core, `@nestjs/common`, `@nestjs/core`, `@nestjs/bullmq`, `bullmq`, `reflect-metadata`).
- `tsconfig.json` — copied verbatim from `packages/mikro-orm/tsconfig.json`.
- `README.md` — quick-start (zero-config: just add the watcher).
- `src/index.ts` — public exports.
- `src/job-content.ts` — `buildJobContent()` + `JobLike`/`JobContent` types (pure, no Nest/bullmq runtime imports).
- `src/job-content.spec.ts` — unit tests for the content builder.
- `src/bullmq-job.watcher.ts` — `BullMqJobWatcher` (discovery + prototype patch + record).
- `src/bullmq-job.watcher.spec.ts` — unit tests with fakes (no Redis).
- `src/bullmq-job.watcher.integration.spec.ts` — real-Redis integration, `describe.skipIf(!process.env.REDIS_URL)`; validates the call-time-patch linchpin against real `@nestjs/bullmq` wiring.

**Core change (one file):**
- `packages/core/src/nest/telescope.module.ts` — import `DiscoveryModule` so `moduleRef.get(DiscoveryService, { strict: false })` resolves for discovery-based watchers.
- `packages/core/src/nest/telescope.module.discovery.spec.ts` — proves `DiscoveryService` is resolvable from a `TelescopeModule.forRoot({})` container.

**Docs/release:**
- `README.md` (root) — add the `@dudousxd/nestjs-telescope-bullmq` row to the packages table.
- `.changeset/config.json` — add the new package to `fixed`/`linked` list.
- `.changeset/<name>.md` — release note.

---

## Task 1: Make `DiscoveryService` resolvable from the Telescope container (core)

**Files:**
- Modify: `packages/core/src/nest/telescope.module.ts`
- Test: `packages/core/src/nest/telescope.module.discovery.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/nest/telescope.module.discovery.spec.ts
import 'reflect-metadata';
import { DiscoveryService } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { TelescopeModule } from './telescope.module.js';

describe('TelescopeModule discovery support', () => {
  it('exposes DiscoveryService so discovery-based watchers can resolve it', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ enabled: true, authorizer: () => true })],
    }).compile();

    const discovery = moduleRef.get(DiscoveryService, { strict: false });
    expect(discovery).toBeInstanceOf(DiscoveryService);
    expect(typeof discovery.getProviders).toBe('function');

    await moduleRef.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- telescope.module.discovery`
Expected: FAIL — `Nest can't resolve DiscoveryService` (DiscoveryModule not imported).

- [ ] **Step 3: Import `DiscoveryModule` in both factory methods**

In `packages/core/src/nest/telescope.module.ts`, add `DiscoveryModule` to the `@nestjs/core` import and include it in `imports` for both `forRoot` and `forRootAsync`:

```ts
import { APP_INTERCEPTOR, DiscoveryModule } from '@nestjs/core';
```

In `forRoot`'s returned `DynamicModule`, add `imports`:

```ts
    return {
      module: TelescopeModule,
      imports: [DiscoveryModule],
      controllers: [TelescopeController],
      providers: [{ provide: TELESCOPE_OPTIONS, useValue: options }, ...SHARED_PROVIDERS],
      exports: [TelescopeService, TELESCOPE_STORAGE],
    };
```

In `forRootAsync`, merge it with any caller-supplied imports (replace the existing conditional `imports` spread):

```ts
    return {
      module: TelescopeModule,
      imports: [DiscoveryModule, ...(config.imports ?? [])],
      controllers: [TelescopeController],
      providers: [
        {
          provide: TELESCOPE_OPTIONS,
          useFactory: config.useFactory,
          inject: config.inject ?? [],
        },
        ...SHARED_PROVIDERS,
      ],
      exports: [TelescopeService, TELESCOPE_STORAGE],
    };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- telescope.module.discovery`
Expected: PASS.

- [ ] **Step 5: Run the full core suite to confirm no regressions**

Run: `pnpm --filter @dudousxd/nestjs-telescope test`
Expected: PASS (request/exception/forRootAsync specs still green; `DiscoveryModule` is additive).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/nest/telescope.module.ts packages/core/src/nest/telescope.module.discovery.spec.ts
git commit -m "feat(core): import DiscoveryModule so watchers can resolve DiscoveryService"
```

---

## Task 2: Scaffold the `@dudousxd/nestjs-telescope-bullmq` package

**Files:**
- Create: `packages/bullmq/package.json`
- Create: `packages/bullmq/tsconfig.json`
- Create: `packages/bullmq/src/index.ts`
- Modify: `.changeset/config.json`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@dudousxd/nestjs-telescope-bullmq",
  "version": "0.0.0",
  "description": "BullMQ job watcher for @dudousxd/nestjs-telescope.",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/DavideCarvalho/nestjs-telescope.git",
    "directory": "packages/bullmq"
  },
  "author": "Davi Carvalho <davi@goflip.ai>",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist/", "README.md", "CHANGELOG.md"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run --passWithNoTests",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "peerDependencies": {
    "@dudousxd/nestjs-telescope": "workspace:*",
    "@nestjs/bullmq": ">=10.0.0",
    "@nestjs/common": ">=10.0.0",
    "@nestjs/core": ">=10.0.0",
    "bullmq": ">=5.0.0",
    "reflect-metadata": ">=0.1.13"
  },
  "devDependencies": {
    "@dudousxd/nestjs-telescope": "workspace:*",
    "@dudousxd/nestjs-telescope-testing": "workspace:*",
    "@nestjs/bullmq": "^11.0.0",
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/testing": "^11.0.0",
    "@types/node": "^20.0.0",
    "bullmq": "^5.0.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1",
    "typescript": "^5.4.0",
    "vitest": "^3.0.0"
  },
  "engines": {
    "node": ">=20"
  },
  "keywords": ["nestjs", "telescope", "bullmq", "queue", "jobs", "observability"]
}
```

> Note: exact `devDependencies` versions should match what the other packages resolve to. After writing this file, run `pnpm install` from the repo root (Step 5) — if pnpm reports a version mismatch with the workspace's pinned versions, align them to the versions already present in `packages/mikro-orm/package.json` / `packages/core/package.json`. Davi's convention is fixed versions; `^` here mirrors the sibling packages' existing devDeps exactly.

- [ ] **Step 2: Create `tsconfig.json` (copy from mikro-orm)**

Run: `cp packages/mikro-orm/tsconfig.json packages/bullmq/tsconfig.json`
(Do not hand-write it — it must stay identical to the sibling packages.)

- [ ] **Step 3: Create a placeholder `src/index.ts`**

```ts
// packages/bullmq/src/index.ts
export {};
```

- [ ] **Step 4: Register the package in changesets `fixed`/`linked`**

Open `.changeset/config.json`. Find the array that lists the workspace packages for synchronized versioning (the `linked` or `fixed` key that already contains `@dudousxd/nestjs-telescope` and `@dudousxd/nestjs-telescope-mikro-orm`). Add `"@dudousxd/nestjs-telescope-bullmq"` to that same array. If the array uses a glob like `["@dudousxd/nestjs-telescope*"]`, no edit is needed — verify and leave it.

- [ ] **Step 5: Install and verify the empty package builds**

Run: `pnpm install`
Then: `pnpm --filter @dudousxd/nestjs-telescope-bullmq build && pnpm --filter @dudousxd/nestjs-telescope-bullmq test`
Expected: build emits `dist/index.js`; test passes with no tests (`--passWithNoTests`).

- [ ] **Step 6: Commit**

```bash
git add packages/bullmq/package.json packages/bullmq/tsconfig.json packages/bullmq/src/index.ts .changeset/config.json pnpm-lock.yaml
git commit -m "chore(bullmq): scaffold @dudousxd/nestjs-telescope-bullmq package"
```

---

## Task 3: Job content builder

**Files:**
- Create: `packages/bullmq/src/job-content.ts`
- Test: `packages/bullmq/src/job-content.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/bullmq/src/job-content.spec.ts
import { describe, expect, it } from 'vitest';
import { buildJobContent } from './job-content.js';

describe('buildJobContent', () => {
  const baseJob = {
    id: 42,
    name: 'send-welcome-email',
    queueName: 'mail',
    attemptsMade: 1,
    opts: { attempts: 3 },
    data: { to: 'ada@example.com' },
  };

  it('builds a completed job content with normalized fields', () => {
    const content = buildJobContent(baseJob, 'completed', undefined, true);
    expect(content).toEqual({
      id: '42',
      name: 'send-welcome-email',
      queue: 'mail',
      status: 'completed',
      attemptsMade: 1,
      maxAttempts: 3,
      failedReason: null,
      data: { to: 'ada@example.com' },
    });
  });

  it('captures the failure reason from an Error and omits it when completed', () => {
    const failed = buildJobContent(baseJob, 'failed', new Error('SMTP down'), true);
    expect(failed.status).toBe('failed');
    expect(failed.failedReason).toBe('SMTP down');
  });

  it('stringifies non-Error failure values', () => {
    const failed = buildJobContent(baseJob, 'failed', 'boom', true);
    expect(failed.failedReason).toBe('boom');
  });

  it('omits data entirely when includeData is false', () => {
    const content = buildJobContent(baseJob, 'completed', undefined, false);
    expect('data' in content).toBe(false);
  });

  it('normalizes missing optional fields to null', () => {
    const content = buildJobContent({}, 'completed', undefined, true);
    expect(content.id).toBeNull();
    expect(content.name).toBeNull();
    expect(content.queue).toBeNull();
    expect(content.attemptsMade).toBeNull();
    expect(content.maxAttempts).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope-bullmq test -- job-content`
Expected: FAIL — `buildJobContent` not found.

- [ ] **Step 3: Write the implementation**

```ts
// packages/bullmq/src/job-content.ts

/** The subset of a BullMQ `Job` this watcher reads. Kept structural so the
 *  content builder needs no bullmq runtime import and is trivially testable. */
export interface JobLike {
  id?: string | number;
  name?: string;
  queueName?: string;
  attemptsMade?: number;
  opts?: { attempts?: number };
  data?: unknown;
}

export type JobStatus = 'completed' | 'failed';

/** Shape persisted as an `Entry.content` for a `job` entry. `data` is omitted
 *  (not null) when capture is disabled, so the column simply isn't present. */
export interface JobContent {
  id: string | null;
  name: string | null;
  queue: string | null;
  status: JobStatus;
  attemptsMade: number | null;
  maxAttempts: number | null;
  failedReason: string | null;
  data?: unknown;
}

function failureMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Normalize a BullMQ job + outcome into a redaction-friendly content object.
 *  Redaction of `data` is applied centrally by the core Recorder, not here. */
export function buildJobContent(
  job: JobLike,
  status: JobStatus,
  error: unknown,
  includeData: boolean,
): JobContent {
  const content: JobContent = {
    id: job.id != null ? String(job.id) : null,
    name: job.name ?? null,
    queue: job.queueName ?? null,
    status,
    attemptsMade: typeof job.attemptsMade === 'number' ? job.attemptsMade : null,
    maxAttempts: typeof job.opts?.attempts === 'number' ? job.opts.attempts : null,
    failedReason: status === 'failed' ? failureMessage(error) : null,
  };
  if (includeData) content.data = job.data;
  return content;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope-bullmq test -- job-content`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit**

```bash
git add packages/bullmq/src/job-content.ts packages/bullmq/src/job-content.spec.ts
git commit -m "feat(bullmq): add job content builder"
```

---

## Task 4: The `BullMqJobWatcher` (discovery + prototype patch + record)

**Files:**
- Create: `packages/bullmq/src/bullmq-job.watcher.ts`
- Test: `packages/bullmq/src/bullmq-job.watcher.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/bullmq/src/bullmq-job.watcher.spec.ts
import 'reflect-metadata';
import {
  type BatchHandle,
  type BatchOrigin,
  type RecordInput,
  type WatcherContext,
  resolveConfig,
} from '@dudousxd/nestjs-telescope';
import { WorkerHost } from '@nestjs/bullmq';
import type { DiscoveryService } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { BullMqJobWatcher } from './bullmq-job.watcher.js';

// A realistic WorkerHost subclass. `process` is what the watcher must wrap.
class EmailProcessor extends WorkerHost {
  public calls = 0;
  // biome-ignore lint/suspicious/noExplicitAny: test stub mirrors BullMQ Job shape loosely
  async process(job: any): Promise<string> {
    this.calls++;
    if (job?.data?.boom) throw new Error('SMTP down');
    return 'ok';
  }
}

class NotAProcessor {
  async process(): Promise<void> {}
}

interface Harness {
  ctx: WatcherContext;
  recorded: RecordInput[];
  origins: BatchOrigin[];
}

function makeHarness(providers: Array<{ instance: unknown }>, clock?: { now(): number }): Harness {
  const recorded: RecordInput[] = [];
  const origins: BatchOrigin[] = [];
  const discovery = {
    getProviders: () => providers,
  } as unknown as DiscoveryService;

  const ctx: WatcherContext = {
    record: (input) => recorded.push(input),
    runInBatch: <T>(origin: BatchOrigin, fn: () => Promise<T>): Promise<T> => {
      origins.push(origin);
      return fn();
    },
    beginBatch: (): BatchHandle => ({ id: 'batch', end: () => {} }),
    config: resolveConfig({}),
    moduleRef: { get: () => discovery } as unknown as WatcherContext['moduleRef'],
  };
  return { ctx, recorded, origins };
}

describe('BullMqJobWatcher', () => {
  it('has type "job"', () => {
    expect(new BullMqJobWatcher().type).toBe('job');
  });

  it('wraps a WorkerHost process() and records a completed job correlated to a queue batch', async () => {
    const proc = new EmailProcessor();
    const { ctx, recorded, origins } = makeHarness([{ instance: proc }]);
    const watcher = new BullMqJobWatcher();

    await watcher.register(ctx);

    const result = await proc.process({
      id: 1,
      name: 'send-welcome-email',
      queueName: 'mail',
      attemptsMade: 1,
      opts: { attempts: 3 },
      data: { to: 'ada@example.com' },
    });

    expect(result).toBe('ok'); // original behavior preserved
    expect(proc.calls).toBe(1); // original actually ran
    expect(origins).toEqual(['queue']); // ran inside a 'queue' batch
    expect(recorded).toHaveLength(1);
    const entry = recorded[0]!;
    expect(entry.type).toBe('job');
    expect(entry.content).toMatchObject({
      id: '1',
      name: 'send-welcome-email',
      queue: 'mail',
      status: 'completed',
    });
    expect(entry.tags).toContain('queue:mail');
    expect(entry.tags).toContain('job:send-welcome-email');
    expect(entry.familyHash).toBe('mail:send-welcome-email');
  });

  it('records a failed job and re-throws so the host still sees the error', async () => {
    const proc = new EmailProcessor();
    const { ctx, recorded } = makeHarness([{ instance: proc }]);
    await new BullMqJobWatcher().register(ctx);

    await expect(
      proc.process({ id: 2, name: 'send', queueName: 'mail', data: { boom: true } }),
    ).rejects.toThrow('SMTP down');

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.content).toMatchObject({ status: 'failed', failedReason: 'SMTP down' });
    expect(recorded[0]!.tags).toContain('failed');
  });

  it('tags slow jobs whose duration meets slowMs', async () => {
    const proc = new EmailProcessor();
    // clock returns 0 then 150 on successive now() calls → duration 150ms.
    let t = 0;
    const clock = {
      now: () => {
        const value = t;
        t += 150;
        return value;
      },
    };
    const { ctx, recorded } = makeHarness([{ instance: proc }], clock);
    await new BullMqJobWatcher({ slowMs: 100, clock }).register(ctx);

    await proc.process({ id: 3, name: 'slow', queueName: 'reports' });

    expect(recorded[0]!.durationMs).toBe(150);
    expect(recorded[0]!.tags).toContain('slow');
  });

  it('ignores non-WorkerHost providers and null instances', async () => {
    const proc = new EmailProcessor();
    const { ctx, recorded } = makeHarness([
      { instance: null },
      { instance: new NotAProcessor() },
      { instance: proc },
    ]);
    await new BullMqJobWatcher().register(ctx);

    // The non-processor's process must NOT be wrapped (no recording).
    await new NotAProcessor().process();
    expect(recorded).toHaveLength(0);

    await proc.process({ id: 4, name: 'x', queueName: 'q' });
    expect(recorded).toHaveLength(1);
  });

  it('patches a shared prototype only once even with multiple instances', async () => {
    const a = new EmailProcessor();
    const b = new EmailProcessor();
    const { ctx, recorded } = makeHarness([{ instance: a }, { instance: b }]);
    await new BullMqJobWatcher().register(ctx);

    await a.process({ id: 5, name: 'x', queueName: 'q' });
    // If the prototype were double-wrapped, this would record twice.
    expect(recorded).toHaveLength(1);
  });

  it('registers cleanly when no processors are present', async () => {
    const { ctx, recorded } = makeHarness([{ instance: new NotAProcessor() }]);
    await expect(new BullMqJobWatcher().register(ctx)).resolves.toBeUndefined();
    expect(recorded).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope-bullmq test -- bullmq-job.watcher`
Expected: FAIL — `BullMqJobWatcher` not found.

- [ ] **Step 3: Write the watcher**

```ts
// packages/bullmq/src/bullmq-job.watcher.ts
import {
  EntryType,
  type RecordInput,
  type Watcher,
  type WatcherContext,
} from '@dudousxd/nestjs-telescope';
import { WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { type JobLike, type JobStatus, buildJobContent } from './job-content.js';

export interface BullMqJobWatcherOptions {
  /** Jobs whose processing time is >= this (ms) get a 'slow' tag. Default 1000. */
  slowMs?: number;
  /** Capture `job.data` in the entry content. Default true (core redaction applies). */
  includeJobData?: boolean;
  /** Time source; injectable for tests. Default wall clock. */
  clock?: { now(): number };
}

/** The prototype-level method we patch. `process(job, token?)` per BullMQ. */
type ProcessHost = { process: (job: unknown, token?: string) => Promise<unknown> };

/**
 * Captures BullMQ jobs and correlates each job's queries/exceptions to its batch.
 *
 * ## How it works
 * At registration the watcher uses NestJS `DiscoveryService` to find every
 * `WorkerHost` provider and replaces its subclass-prototype `process` method
 * with a wrapper that runs the original inside `ctx.runInBatch('queue', ...)`.
 *
 * `@nestjs/bullmq` resolves `instance.process(job, token)` at call-time per job
 * (to support request-scoped processors), and jobs only run after the app has
 * bootstrapped — so a prototype patch applied during `register()` (which the
 * registrar invokes at `onApplicationBootstrap`) always precedes the first job.
 *
 * The wrapper never swallows the host's error: on failure it records a `failed`
 * job entry and re-throws so BullMQ's own retry/lifecycle is unaffected.
 */
export class BullMqJobWatcher implements Watcher {
  readonly type = EntryType.Job;
  private readonly logger = new Logger(BullMqJobWatcher.name);
  private readonly slowMs: number;
  private readonly includeJobData: boolean;
  private readonly clock: { now(): number };
  /** Prototypes already patched, so shared prototypes wrap exactly once. */
  private readonly patched = new WeakSet<object>();

  constructor(options: BullMqJobWatcherOptions = {}) {
    this.slowMs = options.slowMs ?? 1000;
    this.includeJobData = options.includeJobData ?? true;
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  register(ctx: WatcherContext): void {
    const discovery = ctx.moduleRef.get(DiscoveryService, { strict: false });
    let count = 0;
    for (const wrapper of discovery.getProviders()) {
      const instance = wrapper.instance as unknown;
      if (!(instance instanceof WorkerHost)) continue;
      const proto = Object.getPrototypeOf(instance) as object;
      if (this.patched.has(proto)) continue;
      this.patched.add(proto);
      this.patchProcess(proto as ProcessHost, ctx);
      count++;
    }
    if (count === 0) {
      this.logger.warn(
        'BullMqJobWatcher: no @Processor (WorkerHost) providers found. ' +
          'Jobs will not be captured. Ensure your processors are registered before Telescope bootstraps.',
      );
    } else {
      this.logger.log(`BullMqJobWatcher: instrumented ${count} processor class(es).`);
    }
  }

  private patchProcess(proto: ProcessHost, ctx: WatcherContext): void {
    const original = proto.process;
    if (typeof original !== 'function') return;
    const watcher = this;

    proto.process = function patchedProcess(
      this: unknown,
      job: unknown,
      token?: string,
    ): Promise<unknown> {
      return ctx.runInBatch('queue', async () => {
        const startedAt = watcher.clock.now();
        try {
          const result = await original.call(this, job, token);
          watcher.record(ctx, job as JobLike, 'completed', watcher.clock.now() - startedAt, undefined);
          return result;
        } catch (error) {
          watcher.record(ctx, job as JobLike, 'failed', watcher.clock.now() - startedAt, error);
          throw error;
        }
      });
    };
  }

  private record(
    ctx: WatcherContext,
    job: JobLike,
    status: JobStatus,
    durationMs: number,
    error: unknown,
  ): void {
    const content = buildJobContent(job, status, error, this.includeJobData);
    const familyHash = [content.queue, content.name].filter(Boolean).join(':') || null;

    const tags: string[] = [];
    if (content.queue) tags.push(`queue:${content.queue}`);
    if (content.name) tags.push(`job:${content.name}`);
    if (status === 'failed') tags.push('failed');
    if (durationMs >= this.slowMs) tags.push('slow');

    const input: RecordInput = {
      type: EntryType.Job,
      content,
      familyHash,
      durationMs,
    };
    if (tags.length > 0) input.tags = tags;
    ctx.record(input);
  }
}
```

> `exactOptionalPropertyTypes` note: build `input` then conditionally assign `input.tags` (as shown) rather than spreading `tags ?? undefined`. `durationMs` and `familyHash` are always present here so they're assigned directly.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope-bullmq test -- bullmq-job.watcher`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck (catches exactOptionalPropertyTypes / strict issues)**

Run: `pnpm --filter @dudousxd/nestjs-telescope-bullmq typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/bullmq/src/bullmq-job.watcher.ts packages/bullmq/src/bullmq-job.watcher.spec.ts
git commit -m "feat(bullmq): add BullMqJobWatcher with discovery-based processor instrumentation"
```

---

## Task 5: Public exports, README, packages table, changeset

**Files:**
- Modify: `packages/bullmq/src/index.ts`
- Create: `packages/bullmq/README.md`
- Modify: `README.md` (root)
- Create: `.changeset/bullmq-job-watcher.md`

- [ ] **Step 1: Write the public exports**

```ts
// packages/bullmq/src/index.ts
export { BullMqJobWatcher } from './bullmq-job.watcher.js';
export type { BullMqJobWatcherOptions } from './bullmq-job.watcher.js';
export { buildJobContent } from './job-content.js';
export type { JobContent, JobLike, JobStatus } from './job-content.js';
```

- [ ] **Step 2: Write `packages/bullmq/README.md`**

````markdown
# @dudousxd/nestjs-telescope-bullmq

BullMQ job watcher for [`@dudousxd/nestjs-telescope`](../../README.md). Captures
every job (name, queue, outcome, duration, attempts) and correlates the queries
and exceptions a job emits to that job's batch.

## Install

```bash
pnpm add @dudousxd/nestjs-telescope-bullmq
```

Peer deps: `@dudousxd/nestjs-telescope`, `@nestjs/bullmq`, `bullmq`,
`@nestjs/common`, `@nestjs/core`.

## Usage

Add the watcher to `TelescopeModule`. No host wiring is required — the watcher
discovers your `@Processor` (`WorkerHost`) classes and instruments them
automatically.

```ts
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { BullMqJobWatcher } from '@dudousxd/nestjs-telescope-bullmq';

@Module({
  imports: [
    TelescopeModule.forRoot({
      watchers: [new BullMqJobWatcher({ slowMs: 1000 })],
    }),
    // ...your BullModule.registerQueue(...) and @Processor classes
  ],
})
export class AppModule {}
```

Each processed job becomes a `job` entry with `origin: 'queue'`. Queries and
exceptions emitted while the job runs share the job's `batchId`, so opening a
job in the dashboard shows everything it caused.

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `slowMs` | `1000` | Jobs taking at least this long get a `slow` tag. |
| `includeJobData` | `true` | Capture `job.data` (core redaction still applies). |
| `clock` | wall clock | Injectable time source (for tests). |

## Not included

Aggregate queue metrics (throughput, wait time, jobs-per-minute) are a
dashboard/rollup concern handled by `@dudousxd/nestjs-telescope-pulse`, not this
watcher.
````

- [ ] **Step 3: Add the package row to the root `README.md` table**

In the Packages table in `README.md`, add this row directly under the `-mikro-orm` row:

```markdown
| `@dudousxd/nestjs-telescope-bullmq` | ✅ shipped | BullMQ job watcher: per-job capture + query/exception correlation |
```

- [ ] **Step 4: Write the changeset**

```markdown
---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-bullmq': minor
---

Add the BullMQ job watcher (`@dudousxd/nestjs-telescope-bullmq`). It discovers
`@nestjs/bullmq` `WorkerHost` processors and wraps each job in a `'queue'` batch,
capturing job outcome/duration/attempts and correlating the queries and
exceptions a job emits to that job. Core now imports `DiscoveryModule` so
discovery-based watchers can resolve `DiscoveryService`.
```

- [ ] **Step 5: Build, test, lint the whole repo**

Run: `pnpm build && pnpm test && pnpm lint`
Expected: all packages green; biome clean (single quotes, co-located `*.spec.ts` covered by the test override).

- [ ] **Step 6: Commit**

```bash
git add packages/bullmq/src/index.ts packages/bullmq/README.md README.md .changeset/bullmq-job-watcher.md
git commit -m "docs(bullmq): export public API, add README and changeset"
```

---

## Task 6 (optional, validates the linchpin): real-Redis integration test

> This test proves the call-time-patch assumption against real `@nestjs/bullmq`
> wiring. It is skipped unless `REDIS_URL` is set, so CI without Redis stays green.
> Run it locally with a Redis instance to validate the design end-to-end.

**Files:**
- Create: `packages/bullmq/src/bullmq-job.watcher.integration.spec.ts`

- [ ] **Step 1: Write the integration test**

```ts
// packages/bullmq/src/bullmq-job.watcher.integration.spec.ts
import 'reflect-metadata';
import type { Entry } from '@dudousxd/nestjs-telescope';
import { TelescopeModule, TelescopeService } from '@dudousxd/nestjs-telescope';
import { InjectQueue, Processor, WorkerHost, getQueueToken } from '@nestjs/bullmq';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Job, Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BullMqJobWatcher } from './bullmq-job.watcher.js';

const REDIS_URL = process.env.REDIS_URL;
const connection = REDIS_URL ? { url: REDIS_URL } : { host: '127.0.0.1', port: 6379 };

@Processor('telescope-test')
class TestProcessor extends WorkerHost {
  async process(job: Job): Promise<string> {
    if (job.data?.boom) throw new Error('intentional failure');
    return 'done';
  }
}

@Module({
  imports: [
    TelescopeModule.forRoot({
      enabled: true,
      authorizer: () => true,
      watchers: [new BullMqJobWatcher({ slowMs: 999999 })],
    }),
    BullModule.forRoot({ connection }),
    BullModule.registerQueue({ name: 'telescope-test' }),
  ],
  providers: [TestProcessor],
})
class AppModule {}

describe.skipIf(!REDIS_URL)('BullMqJobWatcher integration (real Redis)', () => {
  let app: Awaited<ReturnType<typeof bootstrap>>['app'];
  let queue: Queue;

  async function bootstrap() {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await app.init();
    return { app, moduleRef };
  }

  beforeAll(async () => {
    const booted = await bootstrap();
    app = booted.app;
    queue = booted.moduleRef.get<Queue>(getQueueToken('telescope-test'));
  });

  afterAll(async () => {
    await queue?.obliterate({ force: true }).catch(() => {});
    await app?.close();
  });

  it('records a completed job entry with origin "queue"', async () => {
    await queue.add('greet', { hello: 'world' });

    // Poll Telescope until the job entry lands (worker is async).
    const service = app.get(TelescopeService);
    let jobEntry: Entry | undefined;
    for (let i = 0; i < 50 && !jobEntry; i++) {
      await service.flush();
      const page = await service.list({ type: 'job' });
      jobEntry = page.data.find((e) => e.type === 'job');
      if (!jobEntry) await new Promise((r) => setTimeout(r, 100));
    }

    expect(jobEntry).toBeDefined();
    expect(jobEntry!.origin).toBe('queue');
    expect((jobEntry!.content as { status: string }).status).toBe('completed');
    expect((jobEntry!.content as { queue: string }).queue).toBe('telescope-test');
  });
});
```

> If `TelescopeService` lacks a `list(...)` convenience used above, query through
> the public `TelescopeController`/storage path the other integration specs use
> (e.g. the `/telescope/api/entries` HTTP route via `supertest`, as in
> `packages/mikro-orm/src/mikro-orm-query.watcher.integration.spec.ts`). Match
> whichever read API those specs already exercise — do not invent a new one.

- [ ] **Step 2: Run it (only meaningful with Redis)**

Run (no Redis): `pnpm --filter @dudousxd/nestjs-telescope-bullmq test -- integration`
Expected: the suite is **skipped** (0 failures).

Run (with Redis): `REDIS_URL=redis://127.0.0.1:6379 pnpm --filter @dudousxd/nestjs-telescope-bullmq test -- integration`
Expected: PASS — proves the prototype patch fires under real `@nestjs/bullmq`.

- [ ] **Step 3: Commit**

```bash
git add packages/bullmq/src/bullmq-job.watcher.integration.spec.ts
git commit -m "test(bullmq): add skip-unless-redis integration test for the job watcher"
```

---

## Self-Review

**Spec coverage:**
- Per-job capture (name/queue/outcome/duration/attempts) → Task 3 (`buildJobContent`) + Task 4 (record).
- Query/exception correlation to the job → Task 4 (`runInBatch('queue', ...)` wrapping the original `process`).
- Discovery-based, zero host wiring → Task 1 (DiscoveryService resolvable) + Task 4 (`DiscoveryService.getProviders` + `instanceof WorkerHost`).
- Never swallow host errors → Task 4 failed-path re-throws (tested).
- Robustness: double-patch guard, none-found warning, non-processor/null-instance skipping → Task 4 tests.
- Packaging/release → Task 2 + Task 5.
- End-to-end proof of the call-time-patch linchpin → Task 6.

**Placeholder scan:** No TBDs; every code step shows full code. The only deferred items are explicitly out-of-scope (Horizon aggregate metrics → `-pulse`) and the optional integration read-API note, which points at an existing spec to copy rather than inventing.

**Type consistency:** `BullMqJobWatcher` / `BullMqJobWatcherOptions`, `buildJobContent(job, status, error, includeData)`, `JobContent` fields (`id/name/queue/status/attemptsMade/maxAttempts/failedReason/data?`), `EntryType.Job` (`'job'`), `BatchOrigin` `'queue'`, and `RecordInput` (`type/content/familyHash/tags?/durationMs`) are used identically across tasks and match the core contracts in `packages/core/src/entry/entry.ts`. `runInBatch(origin, fn)` and `ctx.moduleRef.get(DiscoveryService, { strict: false })` match `WatcherContext` in `packages/core/src/nest/watcher.ts`.

**Open assumption (validated by Task 6):** `@nestjs/bullmq` resolves `instance.process` at call-time per job. If a future version binds it once at worker construction, the prototype patch would still apply *iff* it runs before construction — but the registrar runs at `onApplicationBootstrap` (after `onModuleInit` worker creation), so a bind-at-construction version would require moving instrumentation earlier (an `onModuleInit`-phase hook). Task 6 is the canary that catches this.
