# Request + Exception Watchers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Telescope actually capture: a request middleware that opens an ALS batch wrapping the whole request, records a `request` entry on response finish, and an exception interceptor that records an `exception` entry correlated to that same batch — so the dashboard can show "this request → this exception". Plus the plumbing that lets event-based watchers (next plans' Query/Job/Mail) register through the `Watcher` SPI.

**Architecture:** Two integration styles. (1) **Structural** watchers wired by the module via NestJS mechanisms: `TelescopeRequestMiddleware` (opens the `http` batch with `AsyncLocalStorage.enterWith` so it survives the middleware return and reaches the async handler + filters; records the request entry when the response finishes) and `TelescopeExceptionInterceptor` (`APP_INTERCEPTOR`, records the thrown error into the active batch, then re-throws — it never replaces real exception handling). (2) **Event-based** watchers implement `Watcher.register(ctx)`; the module builds a `WatcherContext` and registers each from `options.watchers`. This plan ships the structural pair + the event-based plumbing (no event-based watchers yet).

**Why `enterWith`, not `run`:** `als.run(store, () => next())` pops the store when `next()` returns synchronously — before the async handler completes — so downstream work would lose the batch. `als.enterWith(store)` sets the store for the current async execution and all descendants without a callback, which is the correct request-scoped pattern (same approach as nestjs-cls middleware mode).

**Platform note:** In NestJS **middleware**, both `@nestjs/platform-express` and `@nestjs/platform-fastify` (via `middie`) pass the **raw Node** `req`/`res` (`http.IncomingMessage`/`ServerResponse`). So `req.method`/`req.url`/`req.headers`/`req.socket.remoteAddress` and `res.on('finish')`/`res.statusCode` are uniform across both adapters. The e2e proves it on both.

**Tech Stack:** NestJS 11, `node:async_hooks`, Vitest, Biome. All in `packages/core`.

**Scope:** Request + Exception watchers + WatcherContext/`options.watchers` plumbing + `TelescopeContext.enterWith`. The event-based watchers themselves (Query/Job/Mail/HttpClient/Cache/Gate/Dumps/Schedule/Model) and the strategic features are later plans. This plan ships working, testable software: requests and exceptions are captured and correlated under one batch on Express and Fastify.

**Reference:** `DESIGN.md` (§2 SPIs, §3 correlation, §11 platform). The spine + NestJS host are complete: `TelescopeService` (with `context: TelescopeContext`, `record`, `runInBatch`, `setWatchers`), `Watcher`/`WatcherContext`/`BatchHandle` SPI, `TelescopeModule`, `createBatch`, `Recorder`. Reuse them.

**Conventions:** ESM NodeNext (`.js` imports); no `any` outside `*.spec.ts`; `exactOptionalPropertyTypes` on; Biome single quotes. Tests co-located `*.spec.ts`; run `pnpm --filter @dudousxd/nestjs-telescope test -- <name>.spec`. Commit on `main`, `git -c user.name="Davi Carvalho" -c user.email="davi@goflip.ai" commit`, no Co-Authored-By. All DI is explicit `@Inject` (the package does not rely on emitDecoratorMetadata).

---

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/core/src/context/telescope-context.ts` (modify) | Add `enterWith(batch)`. |
| `packages/core/src/nest/platform-request.ts` | `normalizeRequest(req)` → `{ method, url, headers, ip }` (raw Node req, both platforms). |
| `packages/core/src/nest/watcher-context.factory.ts` | `createWatcherContext(service, config, moduleRef)` → `WatcherContext` (record/runInBatch/beginBatch/config/moduleRef). |
| `packages/core/src/nest/telescope-request.middleware.ts` | Opens `http` batch (`enterWith`), records the request entry on response finish. |
| `packages/core/src/nest/telescope-exception.interceptor.ts` | Records exceptions into the active batch, re-throws. |
| `packages/core/src/nest/telescope.module.ts` (modify) | Register event-based `options.watchers`; apply the request middleware; provide the exception interceptor; report active watcher types. |
| `packages/core/src/index.ts` (modify) | Export the new public pieces. |

---

## Task 1: `TelescopeContext.enterWith`

**Files:**
- Modify: `packages/core/src/context/telescope-context.ts`
- Test: `packages/core/src/context/telescope-context.spec.ts` (extend)

- [ ] **Step 1: Add a failing test** to the existing spec

```ts
  it('enterWith establishes a batch for the rest of the async execution', async () => {
    const { TelescopeContext } = await import('./telescope-context.js');
    const { createBatch } = await import('./batch.js');
    const ctx = new TelescopeContext();

    async function handler() {
      // No callback scope here — the batch must already be active.
      await Promise.resolve();
      return ctx.current()?.id;
    }

    const seen = await ctx.run(createBatch('manual', () => 'outer'), async () => {
      ctx.enterWith(createBatch('http', () => 'req-1'));
      return handler();
    });
    expect(seen).toBe('req-1');
  });
```

> Note: `enterWith` is tested inside a `run` scope so the AsyncLocalStorage frame is isolated to this test and does not leak into sibling tests.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- telescope-context.spec`
Expected: FAIL — `ctx.enterWith is not a function`.

- [ ] **Step 3: Implement `enterWith`** (add the method to the `TelescopeContext` class)

```ts
  /**
   * Establish `batch` as the active batch for the current async execution and
   * all its descendants, WITHOUT a callback scope. Used by the request
   * middleware so the batch survives the middleware return and reaches the
   * async handler and exception interceptor.
   */
  enterWith(batch: Batch): void {
    this.als.enterWith({ batch, sequence: 0 });
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- telescope-context.spec`
Expected: PASS (existing 3 + the new one).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/context/telescope-context.ts packages/core/src/context/telescope-context.spec.ts
git commit -m "feat(core): TelescopeContext.enterWith for callback-less batch scope"
```

---

## Task 2: `normalizeRequest` platform adapter

Normalizes a raw Node request (Express or Fastify-via-middie) into the fields the
request watcher records, without importing express/fastify types.

**Files:**
- Create: `packages/core/src/nest/platform-request.ts`
- Test: `packages/core/src/nest/platform-request.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/nest/platform-request.spec.ts
import { describe, expect, it } from 'vitest';
import { normalizeRequest } from './platform-request.js';

describe('normalizeRequest', () => {
  it('reads method, url, headers, and ip from a raw Node request', () => {
    const req = {
      method: 'GET',
      url: '/orders/42',
      headers: { 'x-trace': 'abc' },
      socket: { remoteAddress: '10.0.0.1' },
    };
    expect(normalizeRequest(req)).toEqual({
      method: 'GET',
      url: '/orders/42',
      headers: { 'x-trace': 'abc' },
      ip: '10.0.0.1',
    });
  });

  it('prefers originalUrl when present (Express) and falls back to url', () => {
    expect(normalizeRequest({ method: 'POST', originalUrl: '/a', url: '/b', headers: {} }).url).toBe('/a');
    expect(normalizeRequest({ method: 'POST', url: '/b', headers: {} }).url).toBe('/b');
  });

  it('defaults missing fields safely', () => {
    expect(normalizeRequest({})).toEqual({ method: 'UNKNOWN', url: '', headers: {}, ip: null });
    expect(normalizeRequest(null)).toEqual({ method: 'UNKNOWN', url: '', headers: {}, ip: null });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- platform-request.spec`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the adapter**

```ts
// packages/core/src/nest/platform-request.ts

export interface NormalizedRequest {
  method: string;
  url: string;
  headers: Record<string, unknown>;
  ip: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** Normalize a raw Node request (Express or Fastify-via-middie) into recordable fields. */
export function normalizeRequest(req: unknown): NormalizedRequest {
  const record = asRecord(req);
  const socket = asRecord(record.socket);
  const url = record.originalUrl !== undefined ? record.originalUrl : record.url;
  const ipCandidate = record.ip !== undefined ? record.ip : socket.remoteAddress;
  return {
    method: asString(record.method, 'UNKNOWN'),
    url: asString(url, ''),
    headers: asRecord(record.headers),
    ip: typeof ipCandidate === 'string' ? ipCandidate : null,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- platform-request.spec`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/nest/platform-request.ts packages/core/src/nest/platform-request.spec.ts
git commit -m "feat(core): platform-agnostic request normalizer"
```

---

## Task 3: `WatcherContext` factory

Builds the concrete `WatcherContext` handed to event-based watchers, including the
handle-style `beginBatch` (built on `enterWith`).

**Files:**
- Create: `packages/core/src/nest/watcher-context.factory.ts`
- Test: `packages/core/src/nest/watcher-context.factory.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/nest/watcher-context.factory.spec.ts
import type { ModuleRef } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config/resolve-config.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeService } from './telescope.service.js';
import { createWatcherContext } from './watcher-context.factory.js';

describe('createWatcherContext', () => {
  it('exposes record/runInBatch/beginBatch/config/moduleRef backed by the service', async () => {
    const storage = new InMemoryStorageProvider();
    const config = resolveConfig({});
    const service = new TelescopeService(config, storage, {});
    const moduleRef = {} as ModuleRef;
    const ctx = createWatcherContext(service, config, moduleRef);

    expect(ctx.config).toBe(config);
    expect(ctx.moduleRef).toBe(moduleRef);

    // beginBatch opens a batch; records inside it correlate.
    const handle = ctx.beginBatch('queue');
    ctx.record({ type: 'job', content: {} });
    handle.end();
    await service.flush();

    const all = (await storage.get({})).data;
    expect(all).toHaveLength(1);
    expect(all[0]?.batchId).toBe(handle.id);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- watcher-context.factory.spec`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Add a `beginBatch` helper to `TelescopeService`** (it owns the context + idFactory)

In `telescope.service.ts`, add:

```ts
  /**
   * Open a batch and make it active for the current async execution (no
   * callback scope). Returns a handle; `end()` is a no-op today (the async
   * scope ends naturally) but is part of the contract for future cleanup.
   */
  beginBatch(origin: BatchOrigin): BatchHandle {
    const batch = createBatch(origin, () => v7());
    if (this.config.enabled) {
      this.context.enterWith(batch);
    }
    return { id: batch.id, end: () => {} };
  }
```

Add the import: `import type { BatchHandle } from './watcher.js';`

- [ ] **Step 4: Write the factory**

```ts
// packages/core/src/nest/watcher-context.factory.ts
import type { ModuleRef } from '@nestjs/core';
import type { ResolvedCoreConfig } from '../config/options.js';
import type { BatchOrigin, RecordInput } from '../entry/entry.js';
import type { TelescopeService } from './telescope.service.js';
import type { BatchHandle, WatcherContext } from './watcher.js';

/** Build the WatcherContext handed to each event-based watcher at registration. */
export function createWatcherContext(
  service: TelescopeService,
  config: ResolvedCoreConfig,
  moduleRef: ModuleRef,
): WatcherContext {
  return {
    record: (input: RecordInput) => service.record(input),
    runInBatch: <T>(origin: BatchOrigin, fn: () => Promise<T>) => service.runInBatch(origin, fn),
    beginBatch: (origin: BatchOrigin): BatchHandle => service.beginBatch(origin),
    config,
    moduleRef,
  };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- watcher-context.factory.spec telescope.service.spec`
Expected: PASS (factory + existing service tests still green).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/nest/watcher-context.factory.ts packages/core/src/nest/watcher-context.factory.spec.ts packages/core/src/nest/telescope.service.ts
git commit -m "feat(core): WatcherContext factory + service.beginBatch"
```

---

## Task 4: `TelescopeRequestMiddleware`

**Files:**
- Create: `packages/core/src/nest/telescope-request.middleware.ts`
- Test: `packages/core/src/nest/telescope-request.middleware.spec.ts`

- [ ] **Step 1: Write the failing test** (drive it with fake raw req/res)

```ts
// packages/core/src/nest/telescope-request.middleware.spec.ts
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config/resolve-config.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeService } from './telescope.service.js';
import { TelescopeRequestMiddleware } from './telescope-request.middleware.js';

describe('TelescopeRequestMiddleware', () => {
  it('opens a batch and records a request entry on response finish', async () => {
    const storage = new InMemoryStorageProvider();
    const service = new TelescopeService(resolveConfig({}), storage, {});
    const mw = new TelescopeRequestMiddleware(service);

    const req = { method: 'GET', url: '/orders/42', headers: {}, socket: { remoteAddress: '10.0.0.1' } };
    const res = Object.assign(new EventEmitter(), { statusCode: 200 });
    const next = vi.fn();

    mw.use(req, res, next);
    expect(next).toHaveBeenCalledOnce();

    // A child entry recorded during the request must share the batch.
    service.record({ type: 'query', content: {} });
    res.emit('finish');
    await service.flush();

    const all = (await storage.get({})).data;
    const request = all.find((e) => e.type === 'request');
    const query = all.find((e) => e.type === 'query');
    expect(request).toBeDefined();
    expect((request?.content as { method: string }).method).toBe('GET');
    expect((request?.content as { statusCode: number }).statusCode).toBe(200);
    expect(request?.batchId).toBe(query?.batchId); // correlated
  });

  it('does nothing recordable when disabled but still calls next', () => {
    const service = new TelescopeService(resolveConfig({ enabled: false }), new InMemoryStorageProvider(), {});
    const mw = new TelescopeRequestMiddleware(service);
    const next = vi.fn();
    mw.use({ method: 'GET', url: '/', headers: {} }, Object.assign(new EventEmitter(), { statusCode: 200 }), next);
    expect(next).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- telescope-request.middleware.spec`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the middleware**

```ts
// packages/core/src/nest/telescope-request.middleware.ts
import { Injectable, type NestMiddleware } from '@nestjs/common';
import { EntryType } from '../entry/entry.js';
import { normalizeRequest } from './platform-request.js';
import { TelescopeService } from './telescope.service.js';

interface FinishableResponse {
  statusCode: number;
  once(event: 'finish', listener: () => void): void;
}

function asFinishable(res: unknown): FinishableResponse | null {
  const r = res as { statusCode?: unknown; once?: unknown };
  return typeof r?.once === 'function' ? (res as FinishableResponse) : null;
}

@Injectable()
export class TelescopeRequestMiddleware implements NestMiddleware {
  constructor(private readonly service: TelescopeService) {}

  use(req: unknown, res: unknown, next: (error?: unknown) => void): void {
    // Open the request batch for the whole downstream async execution.
    this.service.beginBatch('http');

    const request = normalizeRequest(req);
    const startedAt = Date.now();
    const response = asFinishable(res);

    if (response) {
      response.once('finish', () => {
        this.service.record({
          type: EntryType.Request,
          content: {
            method: request.method,
            uri: request.url,
            headers: request.headers,
            ip: request.ip,
            statusCode: response.statusCode,
          },
          durationMs: Date.now() - startedAt,
        });
      });
    }

    next();
  }
}
```

> When disabled, `beginBatch` no-ops the ALS write and `service.record` short-circuits, so nothing is captured — but `next()` still runs.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- telescope-request.middleware.spec`
Expected: PASS (both cases — including the correlated batchId).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/nest/telescope-request.middleware.ts packages/core/src/nest/telescope-request.middleware.spec.ts
git commit -m "feat(core): request watcher middleware (batch + request entry)"
```

---

## Task 5: `TelescopeExceptionInterceptor`

Records an `exception` entry into the active batch and re-throws — never replaces
real exception handling.

**Files:**
- Create: `packages/core/src/nest/telescope-exception.interceptor.ts`
- Test: `packages/core/src/nest/telescope-exception.interceptor.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/nest/telescope-exception.interceptor.spec.ts
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config/resolve-config.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeService } from './telescope.service.js';
import { TelescopeExceptionInterceptor } from './telescope-exception.interceptor.js';

describe('TelescopeExceptionInterceptor', () => {
  it('records the thrown error and re-throws it', async () => {
    const storage = new InMemoryStorageProvider();
    const service = new TelescopeService(resolveConfig({}), storage, {});
    const interceptor = new TelescopeExceptionInterceptor(service);

    const ctx = {} as ExecutionContext;
    const error = new TypeError('boom');
    const next: CallHandler = { handle: () => throwError(() => error) };

    await expect(lastValueFrom(interceptor.intercept(ctx, next))).rejects.toBe(error);
    await service.flush();

    const entry = (await storage.get({ type: 'exception' })).data[0];
    expect(entry).toBeDefined();
    expect((entry?.content as { class: string }).class).toBe('TypeError');
    expect((entry?.content as { message: string }).message).toBe('boom');
    expect(entry?.familyHash).toBe('TypeError:boom'); // groups recurring exceptions
  });

  it('passes successful streams through untouched', async () => {
    const service = new TelescopeService(resolveConfig({}), new InMemoryStorageProvider(), {});
    const interceptor = new TelescopeExceptionInterceptor(service);
    const { of } = await import('rxjs');
    const next: CallHandler = { handle: () => of('ok') };
    expect(await lastValueFrom(interceptor.intercept({} as ExecutionContext, next))).toBe('ok');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- telescope-exception.interceptor.spec`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the interceptor**

```ts
// packages/core/src/nest/telescope-exception.interceptor.ts
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { type Observable, catchError, throwError } from 'rxjs';
import { EntryType } from '../entry/entry.js';
import { TelescopeService } from './telescope.service.js';

@Injectable()
export class TelescopeExceptionInterceptor implements NestInterceptor {
  constructor(private readonly service: TelescopeService) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        this.service.record({
          type: EntryType.Exception,
          familyHash: `${err.name}:${err.message}`,
          content: {
            class: err.name,
            message: err.message,
            stack: err.stack ?? null,
            context: {},
          },
        });
        // Re-throw — the real exception filter still handles the response.
        return throwError(() => error);
      }),
    );
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- telescope-exception.interceptor.spec`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/nest/telescope-exception.interceptor.ts packages/core/src/nest/telescope-exception.interceptor.spec.ts
git commit -m "feat(core): exception watcher interceptor (record + re-throw)"
```

---

## Task 6: Wire watchers into the module + register event-based watchers

**Files:**
- Modify: `packages/core/src/nest/telescope.module.ts`
- Test: `packages/core/src/nest/telescope.module.spec.ts` (extend with a correlation e2e)

- [ ] **Step 1: Add a failing correlation e2e** to the existing module spec

```ts
  it('correlates a request with an exception thrown by its handler', async () => {
    const { Controller, Get } = await import('@nestjs/common');
    @Controller('boom')
    class BoomController {
      @Get()
      go(): never {
        throw new TypeError('kaboom');
      }
    }
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ authorizer: () => true })],
      controllers: [BoomController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await request(app.getHttpServer()).get('/boom').expect(500);
    await app.get(TelescopeService).flush();

    const entries = await request(app.getHttpServer()).get('/telescope/api/entries').expect(200);
    const req = entries.body.data.find((e: { type: string }) => e.type === 'request');
    const exc = entries.body.data.find((e: { type: string }) => e.type === 'exception');
    expect(req).toBeDefined();
    expect(exc).toBeDefined();
    expect(req.batchId).toBe(exc.batchId); // the request and its exception share a batch
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- telescope.module.spec`
Expected: FAIL — request/exception not recorded (middleware + interceptor not wired yet).

- [ ] **Step 3: Wire the module**

Update `telescope.module.ts`:
1. Implement `NestModule.configure` to apply `TelescopeRequestMiddleware` to all routes **except** the Telescope API itself (don't record telescope's own requests):

```ts
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TelescopeRequestMiddleware).exclude('telescope/api/(.*)').forRoutes('*');
  }
```
   (Import `type MiddlewareConsumer`, `type NestModule`, `RequestMethod` as needed; the class now `implements NestModule`.)

2. Add the exception interceptor as a global provider in `SHARED_PROVIDERS`:

```ts
  { provide: APP_INTERCEPTOR, useClass: TelescopeExceptionInterceptor },
```
   (Import `APP_INTERCEPTOR` from `@nestjs/core`.) Also add `TelescopeRequestMiddleware` to `SHARED_PROVIDERS` so Nest can construct it.

3. Add an init step that registers event-based watchers and reports active types. Add a tiny `TelescopeWatcherRegistrar` provider (or do it in `TelescopeService.onModuleInit`): on bootstrap, build a `WatcherContext` via `createWatcherContext(service, config, moduleRef)`, call `watcher.register(ctx)` for each of `options.watchers ?? []`, then `service.setWatchers(['request', 'exception', ...options.watchers.map(w => w.type)])`. Implement this as an `OnApplicationBootstrap` provider that injects `TELESCOPE_OPTIONS`, `TELESCOPE_CONFIG`, `TelescopeService`, and `ModuleRef`. Create `packages/core/src/nest/telescope-watcher-registrar.service.ts` for it and add it to `SHARED_PROVIDERS`.

```ts
// packages/core/src/nest/telescope-watcher-registrar.service.ts
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { ResolvedCoreConfig } from '../config/options.js';
import { EntryType } from '../entry/entry.js';
import { TELESCOPE_CONFIG, TELESCOPE_OPTIONS, type TelescopeModuleOptions } from './telescope.options.js';
import { TelescopeService } from './telescope.service.js';
import { createWatcherContext } from './watcher-context.factory.js';

@Injectable()
export class TelescopeWatcherRegistrar implements OnApplicationBootstrap {
  constructor(
    @Inject(TELESCOPE_OPTIONS) private readonly options: TelescopeModuleOptions,
    @Inject(TELESCOPE_CONFIG) private readonly config: ResolvedCoreConfig,
    private readonly service: TelescopeService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.enabled) return;
    const watchers = this.options.watchers ?? [];
    const ctx = createWatcherContext(this.service, this.config, this.moduleRef);
    for (const watcher of watchers) {
      await watcher.register(ctx);
    }
    this.service.setWatchers([EntryType.Request, EntryType.Exception, ...watchers.map((w) => w.type)]);
  }
}
```
   (Note: `TelescopeService` and `ModuleRef` are injected by type here — both are class providers Nest resolves without metadata because they have no token; if the test harness fails to resolve by type, add explicit `@Inject(TelescopeService)` / `@Inject(ModuleRef)`. Resolve minimally if needed.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- telescope.module.spec`
Expected: PASS — the boom request returns 500, and the request + exception entries share a batchId.

- [ ] **Step 5: Run the WHOLE package**

Run: `pnpm --filter @dudousxd/nestjs-telescope test && pnpm --filter @dudousxd/nestjs-telescope typecheck && npx biome lint packages/core/src`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/nest/telescope.module.ts packages/core/src/nest/telescope-watcher-registrar.service.ts packages/core/src/nest/telescope.module.spec.ts
git commit -m "feat(core): wire request middleware, exception interceptor, watcher registration"
```

---

## Task 7: Fastify correlation parity + barrel + build

**Files:**
- Create: `packages/core/src/nest/telescope-watchers.fastify.spec.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the Fastify correlation e2e**

```ts
// packages/core/src/nest/telescope-watchers.fastify.spec.ts
import { Controller, Get } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { TelescopeModule } from './telescope.module.js';
import { TelescopeService } from './telescope.service.js';

@Controller('boom')
class BoomController {
  @Get()
  go(): never {
    throw new TypeError('kaboom');
  }
}

describe('Watchers (e2e, Fastify)', () => {
  let app: NestFastifyApplication;
  afterEach(async () => { await app?.close(); });

  it('records and correlates request + exception on Fastify', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TelescopeModule.forRoot({ authorizer: () => true })],
      controllers: [BoomController],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    await app.inject({ method: 'GET', url: '/boom' }); // 500
    await app.get(TelescopeService).flush();

    const res = await app.inject({ method: 'GET', url: '/telescope/api/entries' });
    const data = JSON.parse(res.payload).data as { type: string; batchId: string }[];
    const req = data.find((e) => e.type === 'request');
    const exc = data.find((e) => e.type === 'exception');
    expect(req).toBeDefined();
    expect(exc).toBeDefined();
    expect(req?.batchId).toBe(exc?.batchId);
  });
});
```

- [ ] **Step 2: Run to verify it fails (or passes)**

Run: `pnpm --filter @dudousxd/nestjs-telescope test -- telescope-watchers.fastify.spec`
Expected: PASS (the wiring from Task 6 is platform-agnostic). If it FAILS on Fastify (e.g. middleware doesn't run via middie, or ALS doesn't propagate), that's the critical platform bug this task exists to catch — fix it minimally (e.g. ensure `app.register(middie)` isn't needed, or adjust the middleware exclude path syntax for Fastify) and report DONE_WITH_CONCERNS with specifics.

- [ ] **Step 3: Extend the barrel**

Add to `packages/core/src/index.ts`:

```ts
export * from './nest/platform-request.js';
export * from './nest/watcher-context.factory.js';
export * from './nest/telescope-request.middleware.js';
export * from './nest/telescope-exception.interceptor.js';
export * from './nest/telescope-watcher-registrar.service.js';
```

- [ ] **Step 4: Full verification**

Run, all clean:
```
pnpm --filter @dudousxd/nestjs-telescope typecheck
pnpm --filter @dudousxd/nestjs-telescope build
pnpm --filter @dudousxd/nestjs-telescope test
pnpm lint
```
Expected: dist/ emits (no spec files); all specs pass incl. both correlation e2es; Biome clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/nest/telescope-watchers.fastify.spec.ts packages/core/src/index.ts
git commit -m "feat(core): Fastify correlation parity + export watcher pieces"
```

---

## After this plan

Telescope now captures and correlates requests + exceptions on Express and Fastify.
Follow-on plans:

1. **Query watcher** (per-ORM, `-mikro-orm`/`-typeorm`/`-prisma`) — event-based `Watcher.register(ctx)` on the ORM's query stream; also ships each ORM's `StorageProvider`. **N+1 detector** builds on grouping query entries by `familyHash` within a batch.
2. **Job + Mail watchers** — BullMQ + SQS lifecycle; mailer hook. **Horizon-style queue metrics** build on the Job watcher.
3. **Expanded roster** — HttpClient, Cache, Gate, Dumps, Schedule, Model.
4. **`-pulse`** aggregate health dashboard, **`-redis`** store, **`-otel`** bridge, **`-ui`** dashboard.
