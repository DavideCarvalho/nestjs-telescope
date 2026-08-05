// packages/core/src/nest/telescope-crash-capture.e2e.spec.ts
import 'reflect-metadata';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import type { TraceContext } from '../trace/trace-context-provider.js';
import { TelescopeCrashCapture } from './telescope-crash-capture.service.js';
import { TelescopeModule } from './telescope.module.js';
import { TelescopeService } from './telescope.service.js';

/**
 * A stand-in for an OpenTelemetry context provider: an ALS entered by a raw
 * `app.use` middleware, exactly the way a real tracer's context propagation
 * works. It exists so this suite can assert the thing that actually matters for
 * a crash — that the entry lands in the SAME trace as the request that caused
 * it — rather than just asserting a null.
 */
const traceAls = new AsyncLocalStorage<TraceContext>();
let traceCounter = 0;

@Controller('crash')
class CrashController {
  /**
   * A promise nobody awaits and nobody catches. Node raises `unhandledRejection`
   * for it at the end of the tick — after this handler has already returned 200,
   * so nothing on the Nest pipeline (and therefore nothing in the exception
   * interceptor) ever sees it.
   */
  @Get('reject')
  reject(): { ok: boolean } {
    void Promise.reject(new TypeError('rejected inside a request'));
    return { ok: true };
  }

  /** A throw from a timer callback: escapes to the event loop, not to Nest. */
  @Get('throw')
  throwLater(): { ok: boolean } {
    setTimeout(() => {
      throw new RangeError('thrown inside a request');
    }, 0);
    return { ok: true };
  }
}

function settle(ms = 40): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function messageOf(entry: Entry): string | null {
  const content = entry.content;
  if (typeof content !== 'object' || content === null || !('message' in content)) return null;
  const message = content.message;
  return typeof message === 'string' ? message : null;
}

/**
 * Vitest's own `unhandledRejection` / `uncaughtException` listeners are parked
 * for this file. Two reasons, both load-bearing: the crashes below are
 * DELIBERATE and would otherwise fail the run, and `onCrash: 'auto'` counts
 * pre-existing listeners — with the runner's still attached it would read them
 * as "the host already owns the crash" and never exercise the exit branch.
 */
function snapshotListeners() {
  return {
    rejection: process.listeners('unhandledRejection'),
    exception: process.listeners('uncaughtException'),
  };
}

let parked: ReturnType<typeof snapshotListeners> | null = null;
/**
 * Re-attached AFTER Telescope registers (so it does not perturb `'auto'`): if a
 * regression ever stopped the listeners from being installed, this turns a dead
 * test worker into an ordinary failing assertion.
 */
const safetyNet = (): void => undefined;

function parkRunnerListeners(): void {
  parked = snapshotListeners();
  process.removeAllListeners('unhandledRejection');
  process.removeAllListeners('uncaughtException');
}

function restoreRunnerListeners(): void {
  process.removeAllListeners('unhandledRejection');
  process.removeAllListeners('uncaughtException');
  if (parked === null) return;
  for (const listener of parked.rejection) process.on('unhandledRejection', listener);
  for (const listener of parked.exception) process.on('uncaughtException', listener);
  parked = null;
}

describe('process crash capture (e2e, real module graph)', () => {
  let app: INestApplication;
  const storage = new InMemoryStorageProvider();
  let listenersBeforeBoot = 0;

  beforeAll(async () => {
    parkRunnerListeners();
    listenersBeforeBoot =
      process.listenerCount('unhandledRejection') + process.listenerCount('uncaughtException');

    const moduleRef = await Test.createTestingModule({
      imports: [
        TelescopeModule.forRoot({
          enabled: true,
          authorizer: () => true,
          storage,
          traceContext: { current: () => traceAls.getStore() ?? null },
          exceptions: {
            processCrashes: {
              // 'passthrough' is REQUIRED here, not incidental: the honest
              // default ('auto' with no other listener) resolves to 'exit' and
              // would take the test worker down with exit(1) — which is the
              // point of the contract. The exit branch is asserted below on a
              // freshly booted app (mode only) and in the unit spec with
              // `process.exit` spied.
              enabled: true,
              onCrash: 'passthrough',
              flushTimeoutMs: 500,
            },
          },
        }),
      ],
      controllers: [CrashController],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use((_req: unknown, _res: unknown, next: () => void) => {
      traceCounter += 1;
      traceAls.enterWith({
        traceId: `trace-${traceCounter}`.padEnd(32, '0'),
        spanId: `span-${traceCounter}`.padEnd(16, '0'),
      });
      next();
    });
    await app.init();
    process.on('unhandledRejection', safetyNet);
    process.on('uncaughtException', safetyNet);
  });

  afterAll(async () => {
    process.removeListener('unhandledRejection', safetyNet);
    process.removeListener('uncaughtException', safetyNet);
    await app?.close();
    restoreRunnerListeners();
  });

  it('registers the process listeners as part of booting the app', () => {
    const capture = app.get(TelescopeCrashCapture);
    expect(capture.isInstalled).toBe(true);
    expect(capture.resolvedExitMode).toBe('passthrough');
    expect(process.listenerCount('unhandledRejection')).toBe(listenersBeforeBoot + 2);
    expect(process.listenerCount('uncaughtException')).toBe(listenersBeforeBoot + 2);
  });

  it('lands an unhandled rejection in the trace of the request that caused it', async () => {
    await request(app.getHttpServer()).get('/crash/reject').expect(200);
    await settle();
    await app.get(TelescopeService).flush();

    const exceptions = (await storage.get({ type: 'exception' })).data;
    const entry = exceptions.find((e) => messageOf(e) === 'rejected inside a request');
    const requestEntry = (await storage.get({ type: 'request' })).data.find((e) => {
      const content = e.content;
      return (
        typeof content === 'object' &&
        content !== null &&
        'uri' in content &&
        typeof content.uri === 'string' &&
        content.uri.includes('/crash/reject')
      );
    });

    expect(entry).toBeDefined();
    expect(requestEntry).toBeDefined();
    expect(entry?.familyHash).toMatch(/^TypeError:rejected inside a request:at /);
    expect(entry?.tags).toContain('unhandled-rejection');
    expect(entry?.tags).not.toContain('orphaned');
    // The batch survives into the process handler via AsyncLocalStorage, so the
    // crash correlates to its request instead of floating free.
    expect(entry?.batchId).toBe(requestEntry?.batchId);
    expect(entry?.origin).toBe('http');
    expect(entry?.traceId).toBe(requestEntry?.traceId);
    expect(entry?.traceId).not.toBeNull();
  });

  it('lands an uncaught throw from a timer in the trace of its request', async () => {
    await request(app.getHttpServer()).get('/crash/throw').expect(200);
    await settle();
    await app.get(TelescopeService).flush();

    const exceptions = (await storage.get({ type: 'exception' })).data;
    const entry = exceptions.find((e) => messageOf(e) === 'thrown inside a request');
    const requestEntry = (await storage.get({ type: 'request' })).data.find((e) => {
      const content = e.content;
      return (
        typeof content === 'object' &&
        content !== null &&
        'uri' in content &&
        typeof content.uri === 'string' &&
        content.uri.includes('/crash/throw')
      );
    });

    expect(entry).toBeDefined();
    expect(requestEntry).toBeDefined();
    expect(entry?.familyHash).toMatch(/^RangeError:thrown inside a request:at /);
    expect(entry?.tags).toContain('uncaught-exception');
    expect(entry?.batchId).toBe(requestEntry?.batchId);
    expect(entry?.traceId).toBe(requestEntry?.traceId);
    expect(entry?.traceId).not.toBeNull();
  });

  it('records a crash outside any request as explicitly orphaned', async () => {
    void Promise.reject(new Error('rejected with nobody watching'));
    await settle();
    await app.get(TelescopeService).flush();

    const exceptions = (await storage.get({ type: 'exception' })).data;
    const entry = exceptions.find((e) => messageOf(e) === 'rejected with nobody watching');

    expect(entry).toBeDefined();
    // Genuinely unattributable — recorded and SAID so, rather than dropped or
    // quietly hung off a synthetic batch that pretends to be a request.
    expect(entry?.tags).toContain('orphaned');
    expect(entry?.origin).toBe('manual');
    expect(entry?.traceId).toBeNull();
  });

  it('removes its listeners when the app shuts down', async () => {
    await app.close();
    expect(process.listenerCount('unhandledRejection')).toBe(listenersBeforeBoot + 1);
    expect(process.listenerCount('uncaughtException')).toBe(listenersBeforeBoot + 1);
    expect(app.get(TelescopeCrashCapture).isInstalled).toBe(false);
    // Re-close in afterAll is a no-op; asserting here keeps the teardown check
    // inside a test rather than in a hook where a failure is invisible.
  });
});

describe('process crash capture exit contract (e2e)', () => {
  /**
   * A separately booted app, run AFTER the suite above has closed its own (so
   * the process-wide install slot is free), asserting the honest default: with
   * nothing else listening, Telescope resolves to `'exit'` — the mode that
   * reproduces the crash Node would have had. Actually letting it fire would
   * end the test worker, so only the resolved contract is asserted here; the
   * stderr write and `process.exit(code)` themselves are covered in
   * `telescope-crash-capture.spec.ts` with `process.exit` spied.
   */
  it("defaults to 'exit' when the host has no crash handler of its own", async () => {
    parkRunnerListeners();
    try {
      const moduleRef = await Test.createTestingModule({
        imports: [
          TelescopeModule.forRoot({
            enabled: true,
            authorizer: () => true,
            storage: new InMemoryStorageProvider(),
            exceptions: { processCrashes: { enabled: true } },
          }),
        ],
      }).compile();
      const exitApp = moduleRef.createNestApplication();
      await exitApp.init();
      const capture = exitApp.get(TelescopeCrashCapture);
      expect(capture.isInstalled).toBe(true);
      expect(capture.resolvedExitMode).toBe('exit');
      await exitApp.close();
      expect(capture.isInstalled).toBe(false);
    } finally {
      restoreRunnerListeners();
    }
  });
});
