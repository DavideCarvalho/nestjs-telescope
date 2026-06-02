# HTTP-Client Watcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture outbound HTTP calls (method, URL, host, status, duration) made via the global `fetch`, correlated to the request/job that made them, as a built-in core watcher (`HttpClientWatcher`). Opt-in via `TelescopeModule.forRoot({ watchers: [new HttpClientWatcher()] })`.

**Architecture:** Unlike the ORM/queue adapters, this needs no peer dependency — it instruments Node's built-in global `fetch`. At `register(ctx)` the watcher replaces `globalThis.fetch` with a wrapper that times the call, records an `http_client` entry via `ctx.record`, and returns/re-throws transparently. Because `fetch` runs inside the caller's async context, the active AsyncLocalStorage batch (set by the request middleware) is live when the wrapper records — so outbound calls correlate to their request/job with no extra wiring. Recording is guarded (`safeRecord`) so a telescope failure can never alter the host's HTTP result, and the host's network error is always re-thrown. The patch is idempotent (a symbol marker) so multiple watcher instances / re-registration wrap `fetch` exactly once.

**Tech Stack:** TypeScript (ESM/NodeNext, strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess), NestJS 11, vitest, biome, pnpm+turbo, changesets. Core package only; no peer deps (Node >= 20 global `fetch`/`URL`/`Request`).

---

## File Structure

**Core (`packages/core/`):**
- `src/entry/entry.ts` (modify) — add `EntryType.HttpClient = 'http_client'`.
- `src/entry/content.ts` (modify) — add `HttpClientContent`.
- `src/http/http-client.watcher.ts` (new) — `HttpClientWatcher` + `describeRequest` helper.
- `src/index.ts` (modify) — export the watcher.
- Co-located `src/http/http-client.watcher.spec.ts` (unit, fake fetch) and `src/http/http-client.watcher.e2e.spec.ts` (real fetch + local server + request middleware → correlation).

---

## Task 1: `EntryType.HttpClient`, `HttpClientContent`, and `HttpClientWatcher`

**Files:**
- Modify: `packages/core/src/entry/entry.ts`
- Modify: `packages/core/src/entry/content.ts`
- Create: `packages/core/src/http/http-client.watcher.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/http/http-client.watcher.spec.ts`

- [ ] **Step 1: Additive type changes.**

In `packages/core/src/entry/entry.ts`, add `HttpClient: 'http_client'` to the `EntryType` object (after `Mail`):
```ts
export const EntryType = {
  Request: 'request',
  Query: 'query',
  Job: 'job',
  Exception: 'exception',
  Mail: 'mail',
  HttpClient: 'http_client',
} as const;
```

In `packages/core/src/entry/content.ts`, add:
```ts
export interface HttpClientContent {
  method: string;
  url: string;
  host: string | null;
  statusCode: number | null;
  durationMs: number;
}
```

- [ ] **Step 2: Write the failing test** — `packages/core/src/http/http-client.watcher.spec.ts`:

```ts
// packages/core/src/http/http-client.watcher.spec.ts
import 'reflect-metadata';
import {
  type BatchHandle,
  type BatchOrigin,
  type RecordInput,
  type WatcherContext,
  resolveConfig,
} from '@dudousxd/nestjs-telescope';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpClientWatcher } from './http-client.watcher.js';

interface Harness {
  ctx: WatcherContext;
  recorded: RecordInput[];
}

function makeHarness(): Harness {
  const recorded: RecordInput[] = [];
  const ctx: WatcherContext = {
    record: (input) => recorded.push(input),
    runInBatch: <T>(_origin: BatchOrigin, fn: () => Promise<T>): Promise<T> => fn(),
    beginBatch: (): BatchHandle => ({ id: 'b', end: () => {} }),
    config: resolveConfig({}),
    moduleRef: { get: () => undefined } as unknown as WatcherContext['moduleRef'],
  };
  return { ctx, recorded };
}

describe('HttpClientWatcher', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('has type "http_client"', () => {
    expect(new HttpClientWatcher().type).toBe('http_client');
  });

  it('records a successful outbound request with method/url/host/status/duration', async () => {
    const fakeResponse = { status: 200 } as Response;
    globalThis.fetch = vi.fn(async () => fakeResponse) as typeof globalThis.fetch;
    const { ctx, recorded } = makeHarness();
    new HttpClientWatcher().register(ctx);

    const result = await globalThis.fetch('https://api.example.com/users?page=1');

    expect(result).toBe(fakeResponse); // transparent pass-through
    expect(recorded).toHaveLength(1);
    const entry = recorded[0]!;
    expect(entry.type).toBe('http_client');
    expect(entry.content).toMatchObject({
      method: 'GET',
      url: 'https://api.example.com/users?page=1',
      host: 'api.example.com',
      statusCode: 200,
    });
    expect(entry.familyHash).toBe('GET api.example.com');
  });

  it('uses the method from init and tags 5xx + slow', async () => {
    let t = 0;
    const clock = { now: () => { const v = t; t += 1500; return v; } };
    globalThis.fetch = vi.fn(async () => ({ status: 503 }) as Response) as typeof globalThis.fetch;
    const { ctx, recorded } = makeHarness();
    new HttpClientWatcher({ slowMs: 1000, clock }).register(ctx);

    await globalThis.fetch('https://api.example.com/x', { method: 'post' });

    const entry = recorded[0]!;
    expect((entry.content as { method: string }).method).toBe('POST');
    expect((entry.content as { statusCode: number }).statusCode).toBe(503);
    expect(entry.durationMs).toBe(1500);
    expect(entry.tags).toContain('failed'); // 5xx
    expect(entry.tags).toContain('slow');
    expect(entry.tags).toContain('host:api.example.com');
  });

  it('records a network failure (statusCode null, failed) and re-throws', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof globalThis.fetch;
    const { ctx, recorded } = makeHarness();
    new HttpClientWatcher().register(ctx);

    await expect(globalThis.fetch('https://down.example.com/')).rejects.toThrow('ECONNREFUSED');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.content).toMatchObject({ statusCode: null });
    expect(recorded[0]!.tags).toContain('failed');
  });

  it('patches fetch only once across multiple registrations', async () => {
    const inner = vi.fn(async () => ({ status: 200 }) as Response);
    globalThis.fetch = inner as typeof globalThis.fetch;
    const { ctx, recorded } = makeHarness();
    new HttpClientWatcher().register(ctx);
    new HttpClientWatcher().register(ctx); // second register must NOT double-wrap

    await globalThis.fetch('https://api.example.com/x');
    expect(inner).toHaveBeenCalledTimes(1); // original called once (not wrapper-of-wrapper)
    expect(recorded).toHaveLength(1); // recorded once, not twice
  });

  it('extracts method/url from a Request object', async () => {
    globalThis.fetch = vi.fn(async () => ({ status: 200 }) as Response) as typeof globalThis.fetch;
    const { ctx, recorded } = makeHarness();
    new HttpClientWatcher().register(ctx);

    await globalThis.fetch(new Request('https://api.example.com/r', { method: 'DELETE' }));
    expect(recorded[0]!.content).toMatchObject({ method: 'DELETE', host: 'api.example.com' });
  });

  it('never throws into the host when recording fails', async () => {
    globalThis.fetch = vi.fn(async () => ({ status: 200 }) as Response) as typeof globalThis.fetch;
    const recorded: RecordInput[] = [];
    const ctx = {
      record: () => {
        throw new Error('recorder boom');
      },
      runInBatch: <T>(_o: BatchOrigin, fn: () => Promise<T>) => fn(),
      beginBatch: (): BatchHandle => ({ id: 'b', end: () => {} }),
      config: resolveConfig({}),
      moduleRef: { get: () => undefined },
    } as unknown as WatcherContext;
    new HttpClientWatcher().register(ctx);

    await expect(globalThis.fetch('https://api.example.com/x')).resolves.toMatchObject({ status: 200 });
    void recorded;
  });
});
```

- [ ] **Step 3: Run, verify FAIL:** `pnpm --filter @dudousxd/nestjs-telescope test -- http-client.watcher.spec`

- [ ] **Step 4: Implement `packages/core/src/http/http-client.watcher.ts`:**

```ts
// packages/core/src/http/http-client.watcher.ts
import { Logger } from '@nestjs/common';
import type { HttpClientContent } from '../entry/content.js';
import { EntryType } from '../entry/entry.js';
import type { Watcher, WatcherContext } from '../nest/watcher.js';

export interface HttpClientWatcherOptions {
  /** Outbound calls at/above this many ms get a 'slow' tag. Default 1000. */
  slowMs?: number;
  /** Time source; injectable for tests. Default wall clock. */
  clock?: { now(): number };
}

/** Marks a wrapped `fetch` so we patch the global exactly once. */
const PATCHED = Symbol.for('@dudousxd/nestjs-telescope:httpClientPatched');

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

/** Pull method/url/host out of fetch's (input, init) without throwing. */
function describeRequest(
  input: FetchInput,
  init: FetchInit,
): { method: string; url: string; host: string | null } {
  let url = '';
  let method = 'GET';
  if (typeof input === 'string') url = input;
  else if (input instanceof URL) url = input.href;
  else if (input instanceof Request) {
    url = input.url;
    method = input.method;
  }
  if (init && typeof init.method === 'string') method = init.method;

  let host: string | null = null;
  try {
    host = new URL(url).host;
  } catch {
    host = null;
  }
  return { method: method.toUpperCase(), url, host };
}

/**
 * Captures outbound HTTP calls made via the global `fetch`, correlated to the
 * request/job that made them.
 *
 * `fetch` runs inside the caller's async context, so the active ALS batch (set
 * by the request middleware) is live when the wrapper records — no extra wiring
 * is needed for correlation. Recording is guarded so a telescope failure can
 * never change the host's HTTP result, and the host's network error is always
 * re-thrown. The patch is idempotent across instances via a symbol marker.
 *
 * @remarks
 * Only the global `fetch` is instrumented. Clients that bypass it (a custom
 * `http.request`, native addons) are not captured. The global is replaced for
 * the process lifetime (not restored on shutdown) — appropriate for an
 * always-on observability tool.
 */
export class HttpClientWatcher implements Watcher {
  readonly type = EntryType.HttpClient;
  private readonly logger = new Logger(HttpClientWatcher.name);
  private readonly slowMs: number;
  private readonly clock: { now(): number };

  constructor(options: HttpClientWatcherOptions = {}) {
    this.slowMs = options.slowMs ?? 1000;
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  register(ctx: WatcherContext): void {
    const current = globalThis.fetch;
    if (typeof current !== 'function') {
      this.logger.warn('HttpClientWatcher: global fetch is unavailable; outbound calls will not be captured.');
      return;
    }
    if ((current as { [PATCHED]?: boolean })[PATCHED]) return;

    const watcher = this;
    const patched = async function patchedFetch(
      input: FetchInput,
      init?: FetchInit,
    ): Promise<Response> {
      const startedAt = watcher.clock.now();
      const { method, url, host } = describeRequest(input, init);
      try {
        const response = await current(input, init);
        watcher.safeRecord(ctx, {
          method,
          url,
          host,
          statusCode: response.status,
          durationMs: watcher.clock.now() - startedAt,
        });
        return response;
      } catch (error) {
        watcher.safeRecord(ctx, {
          method,
          url,
          host,
          statusCode: null,
          durationMs: watcher.clock.now() - startedAt,
        });
        throw error; // never swallow the host's network error
      }
    };
    (patched as { [PATCHED]?: boolean })[PATCHED] = true;
    globalThis.fetch = patched as typeof globalThis.fetch;
  }

  /** Hand an entry to the Recorder, swallowing any failure so a telescope bug
   *  can never alter the host's HTTP call. */
  private safeRecord(ctx: WatcherContext, content: HttpClientContent): void {
    try {
      const tags: string[] = [];
      if (content.host) tags.push(`host:${content.host}`);
      if (content.statusCode === null || content.statusCode >= 500) tags.push('failed');
      if (content.durationMs >= this.slowMs) tags.push('slow');

      ctx.record({
        type: EntryType.HttpClient,
        content,
        familyHash: `${content.method} ${content.host ?? ''}`.trim() || null,
        durationMs: content.durationMs,
        ...(tags.length > 0 ? { tags } : {}),
      });
    } catch (recordError) {
      const message = recordError instanceof Error ? recordError.message : String(recordError);
      this.logger.error(`HttpClientWatcher: failed to record entry: ${message}`);
    }
  }
}
```

- [ ] **Step 5: Export from index.** In `packages/core/src/index.ts` add (with a new http group):
```ts
export * from './http/http-client.watcher.js';
```

- [ ] **Step 6: Run, verify PASS + typecheck + lint:**
- `pnpm --filter @dudousxd/nestjs-telescope test -- http-client.watcher.spec` → 7 pass
- `pnpm --filter @dudousxd/nestjs-telescope test` → full core suite green
- `pnpm --filter @dudousxd/nestjs-telescope typecheck` → clean
- `pnpm lint` → clean

- [ ] **Step 7: Commit**
```bash
git add packages/core/src/entry/entry.ts packages/core/src/entry/content.ts packages/core/src/http/http-client.watcher.ts packages/core/src/http/http-client.watcher.spec.ts packages/core/src/index.ts
git commit -m "feat(core): add HttpClientWatcher instrumenting global fetch"
```

---

## Task 2: End-to-end correlation test (real fetch + request batch)

**Files:**
- Create: `packages/core/src/http/http-client.watcher.e2e.spec.ts`

This proves the load-bearing claim — that an outbound `fetch` made inside a request handler produces an `http_client` entry sharing the request's `batchId` — against the real request middleware and real ALS, using a local HTTP server (no external dependency, CI-runnable).

- [ ] **Step 1: Write the test** — `packages/core/src/http/http-client.watcher.e2e.spec.ts`:

```ts
// packages/core/src/http/http-client.watcher.e2e.spec.ts
import 'reflect-metadata';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { HttpClientWatcher } from './http-client.watcher.js';
import { TelescopeModule } from '../nest/telescope.module.js';

describe('HttpClientWatcher e2e correlation', () => {
  let app: INestApplication;
  let upstream: Server;
  let upstreamUrl: string;
  const originalFetch = globalThis.fetch;

  // A controller that makes an outbound fetch while handling a request.
  @Controller('caller')
  class CallerController {
    @Get()
    async call(): Promise<{ ok: boolean }> {
      await fetch(upstreamUrl);
      return { ok: true };
    }
  }

  beforeAll(async () => {
    upstream = createServer((_req, res) => res.end('hello'));
    await new Promise<void>((resolve) => upstream.listen(0, resolve));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/`;

    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeModule.forRoot({
          enabled: true,
          authorizer: () => true,
          watchers: [new HttpClientWatcher()],
        }),
      ],
      controllers: [CallerController],
    }).compile();
    app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    globalThis.fetch = originalFetch; // watcher patched the global; restore it
  });

  it('correlates an outbound fetch to the request batch', async () => {
    await request(app.getHttpServer()).get('/caller').expect(200);
    await app.getHttpServer(); // ensure handler finished
    const { TelescopeService } = await import('../nest/telescope.service.js');
    await app.get(TelescopeService).flush();

    const res = await request(app.getHttpServer()).get('/telescope/api/entries').expect(200);
    const entries: Entry[] = (res.body as { data: Entry[] }).data;

    const httpClient = entries.find((e) => e.type === 'http_client');
    const requestEntry = entries.find(
      (e) => e.type === 'request' && typeof (e.content as { uri?: unknown }).uri === 'string' && (e.content as { uri: string }).uri.includes('caller'),
    );
    expect(httpClient).toBeDefined();
    expect(requestEntry).toBeDefined();
    expect(httpClient!.batchId).toBe(requestEntry!.batchId);
    expect((httpClient!.content as { host: string }).host).toBe(`127.0.0.1:${(upstream.address() as AddressInfo).port}`);
  });
});
```

> Note: the watcher patches the process-global `fetch`; restore it in `afterAll` so other suites are unaffected. The `/telescope/api/*` route is excluded from the request middleware, but the `/caller` request opens a batch via the middleware's `enterWith`, and the handler's `fetch` runs in that ALS context — that is what this test verifies.

- [ ] **Step 2: Run, verify PASS** (it should pass once Task 1 is in):
`pnpm --filter @dudousxd/nestjs-telescope test -- http-client.watcher.e2e`
Expected: PASS — the `http_client` entry shares the `/caller` request's `batchId`.

- [ ] **Step 3: Run the full suite + lint to confirm no global-fetch leakage into other suites:**
- `pnpm --filter @dudousxd/nestjs-telescope test` → all green (the e2e restores `globalThis.fetch`)
- `pnpm lint` → clean

- [ ] **Step 4: Commit**
```bash
git add packages/core/src/http/http-client.watcher.e2e.spec.ts
git commit -m "test(core): e2e prove HttpClientWatcher correlates outbound fetch to its request"
```

---

## Task 3: Docs + changeset + whole-repo verification

**Files:**
- Modify: `README.md` (root)
- Create: `.changeset/http-client-watcher.md`

- [ ] **Step 1: Document in the root `README.md`.** READ it first. Near the watcher/quick-start area, add a short note (place after the pulse paragraph or wherever watchers are described):

```markdown
To capture outbound HTTP calls (correlated to the request/job that made them),
add the built-in `HttpClientWatcher` — it instruments the global `fetch`, no peer
dependency required:

```ts
import { TelescopeModule, HttpClientWatcher } from '@dudousxd/nestjs-telescope';

TelescopeModule.forRoot({ watchers: [new HttpClientWatcher({ slowMs: 1000 })] });
```
```

(Use a nested fenced block correctly — match the README's existing code-fence style.)

- [ ] **Step 2: Write the changeset** `.changeset/http-client-watcher.md`:

```markdown
---
'@dudousxd/nestjs-telescope': minor
---

Add `HttpClientWatcher`, a built-in watcher that instruments the global `fetch`
to capture outbound HTTP calls (method, URL, host, status, duration) correlated
to the request/job that made them. No peer dependency — it uses Node's built-in
`fetch`. Adds the `http_client` entry type and `HttpClientContent`.
```

- [ ] **Step 3: Whole-repo build + test + lint**
```bash
pnpm build
pnpm test
pnpm lint
```
All green; biome clean. Report the summary numbers.

- [ ] **Step 4: Commit**
```bash
git add README.md .changeset/http-client-watcher.md
git commit -m "docs: document HttpClientWatcher and add changeset"
```

---

## Self-Review

**Spec coverage:**
- Outbound capture (method/url/host/status/duration) → Task 1 watcher + content type.
- Correlation to the originating request/job → Task 2 e2e (real ALS, real middleware, local server).
- Robustness (never alter host result, always re-throw network error, idempotent patch, defensive request parsing) → Task 1 (`safeRecord`, re-throw, `PATCHED` symbol, `describeRequest`).
- Opt-in, no peer dep, exposed from core → Task 1 export + Task 3 docs/changeset.

**Placeholder scan:** No TBDs; complete code throughout. Unit tests use a faked global `fetch`; the e2e uses a real local server + real request batch and restores `globalThis.fetch`. A per-host allow/deny filter, request/response body capture, and instrumenting non-`fetch` clients (`http.request`, axios) are intentionally out of scope (noted, not stubbed).

**Type consistency:** `EntryType.HttpClient` (`'http_client'`) and `HttpClientContent` ({method,url,host,statusCode,durationMs}) are defined in core and used identically by the watcher, its `safeRecord`, and both specs. `HttpClientWatcher` implements the core `Watcher` SPI (`type`, `register(ctx)`); it records via `ctx.record` into the ambient batch (it is NOT an entry-point watcher and does not open its own batch). `describeRequest` handles `string | URL | Request` inputs plus an `init.method` override, defensively (never throws). `safeRecord` mirrors the BullMQ watcher's guard so recording can never throw into the host.

**Correlation rationale:** outbound `fetch` executes within the caller's async context, so the request middleware's ALS batch is active when `safeRecord` runs — correlation needs no per-call wiring. This is the key difference from event-emitter-based query logging (e.g. Prisma `$on('query')`), whose events fire detached from the caller's context.
