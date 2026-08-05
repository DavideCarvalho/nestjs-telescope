// packages/core/src/nest/telescope-crash-capture.spec.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config/resolve-config.js';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeCrashCapture } from './telescope-crash-capture.service.js';
import type { TelescopeModuleOptions } from './telescope.options.js';
import { TelescopeService } from './telescope.service.js';

/**
 * Vitest installs its OWN `unhandledRejection` / `uncaughtException` listeners
 * to fail a run on stray async errors. This suite deliberately emits both
 * events, so those listeners are parked for the duration of each test and
 * restored afterwards — otherwise every assertion here would also be reported as
 * a runner-level failure, and the `'auto'` mode tests (which count PRE-EXISTING
 * listeners) would read the runner's listeners as "the host already decides".
 */
function snapshotListeners() {
  return {
    rejection: process.listeners('unhandledRejection'),
    exception: process.listeners('uncaughtException'),
  };
}

let parked: ReturnType<typeof snapshotListeners> | null = null;

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

function build(options: TelescopeModuleOptions) {
  const storage = new InMemoryStorageProvider();
  const config = resolveConfig(options);
  const service = new TelescopeService(config, storage, options);
  const capture = new TelescopeCrashCapture(service, options, config);
  return { storage, service, capture };
}

/** Options that record without ever touching the exit path. */
function passthroughOptions(extra: Record<string, unknown> = {}): TelescopeModuleOptions {
  return {
    exceptions: { processCrashes: { enabled: true, onCrash: 'passthrough', ...extra } },
  };
}

/** Let the (intentionally async) capture path settle before asserting. */
function settle(ms = 20): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function exceptions(
  service: TelescopeService,
  storage: InMemoryStorageProvider,
): Promise<Entry[]> {
  await service.flush();
  return (await storage.get({ type: 'exception' })).data;
}

describe('TelescopeCrashCapture', () => {
  beforeEach(() => parkRunnerListeners());

  afterEach(() => {
    restoreRunnerListeners();
    vi.restoreAllMocks();
  });

  it('registers no process listeners unless explicitly enabled', () => {
    const withoutOption = build({});
    withoutOption.capture.onModuleInit();
    expect(withoutOption.capture.isInstalled).toBe(false);

    const disabled = build({ exceptions: { processCrashes: { enabled: false } } });
    disabled.capture.onModuleInit();
    expect(disabled.capture.isInstalled).toBe(false);

    // The point of the whole design: nothing was attached, so the host's crash
    // semantics are byte-for-byte what Node gives it.
    expect(process.listenerCount('unhandledRejection')).toBe(0);
    expect(process.listenerCount('uncaughtException')).toBe(0);
  });

  it('registers no listeners when Telescope capture itself is disabled', () => {
    const { capture } = build({ enabled: false, ...passthroughOptions() });
    capture.onModuleInit();
    expect(capture.isInstalled).toBe(false);
    expect(process.listenerCount('uncaughtException')).toBe(0);
  });

  it('attaches both listeners on init and removes exactly them on destroy', () => {
    const { capture } = build(passthroughOptions());
    capture.onModuleInit();

    expect(capture.isInstalled).toBe(true);
    expect(process.listenerCount('unhandledRejection')).toBe(1);
    expect(process.listenerCount('uncaughtException')).toBe(1);

    capture.onModuleDestroy();

    // A leaked listener here is how this kind of code poisons the NEXT test
    // file in the run, so the count going back to zero is the assertion.
    expect(capture.isInstalled).toBe(false);
    expect(process.listenerCount('unhandledRejection')).toBe(0);
    expect(process.listenerCount('uncaughtException')).toBe(0);
  });

  it('records an unhandled rejection as an orphaned exception entry', async () => {
    const { capture, service, storage } = build(passthroughOptions());
    capture.onModuleInit();

    process.emit('unhandledRejection', new TypeError('nobody awaited me'), Promise.resolve());
    await settle();

    const [entry] = await exceptions(service, storage);
    capture.onModuleDestroy();

    expect(entry).toBeDefined();
    expect(entry?.familyHash).toMatch(/^TypeError:nobody awaited me:at /);
    expect(entry?.tags).toContain('unhandled');
    expect(entry?.tags).toContain('unhandled-rejection');
    expect(entry?.tags).toContain('failed');
    // With no active batch the crash is genuinely orphaned. Recorded as such,
    // explicitly, rather than dropped or quietly attached to a synthetic batch.
    expect(entry?.tags).toContain('orphaned');
    expect(entry?.origin).toBe('manual');
  });

  it('inherits the active batch instead of tagging orphaned', async () => {
    const { capture, service, storage } = build(passthroughOptions());
    capture.onModuleInit();

    const batchId = await service.runInBatch('queue', async () => {
      process.emit('uncaughtException', new Error('threw inside a job'));
      // The record happens synchronously inside the process handler, so it is
      // still in this batch's async scope; only the flush is deferred.
      const current = service.context.current();
      return current?.id ?? null;
    });
    await settle();

    const [entry] = await exceptions(service, storage);
    capture.onModuleDestroy();

    expect(entry).toBeDefined();
    expect(entry?.batchId).toBe(batchId);
    expect(entry?.origin).toBe('queue');
    expect(entry?.tags).toContain('uncaught-exception');
    expect(entry?.tags).not.toContain('orphaned');
  });

  it('coerces a non-Error rejection reason without throwing', async () => {
    const { capture, service, storage } = build(passthroughOptions());
    capture.onModuleInit();

    const hostile = {
      toString() {
        throw new Error('toString is a trap');
      },
    };
    process.emit('unhandledRejection', hostile, Promise.resolve());
    process.emit('unhandledRejection', 'a bare string', Promise.resolve());
    await settle();

    const entries = await exceptions(service, storage);
    capture.onModuleDestroy();

    expect(entries).toHaveLength(2);
    const messages = entries.map((entry) => {
      const content = entry.content;
      return typeof content === 'object' && content !== null && 'message' in content
        ? content.message
        : null;
    });
    expect(messages).toContain('<unstringifiable rejection reason>');
    expect(messages).toContain('a bare string');
  });

  it('installs once per process, so two module instances record one entry', async () => {
    const first = build(passthroughOptions());
    const second = build(passthroughOptions());
    first.capture.onModuleInit();
    second.capture.onModuleInit();

    expect(first.capture.isInstalled).toBe(true);
    expect(second.capture.isInstalled).toBe(false);
    expect(process.listenerCount('unhandledRejection')).toBe(1);

    process.emit('unhandledRejection', new Error('once'), Promise.resolve());
    await settle();

    const firstEntries = await exceptions(first.service, first.storage);
    const secondEntries = await exceptions(second.service, second.storage);
    // A no-op destroy on the instance that stood down must not release the slot
    // out from under the owner.
    second.capture.onModuleDestroy();
    expect(process.listenerCount('unhandledRejection')).toBe(1);
    first.capture.onModuleDestroy();

    expect(firstEntries).toHaveLength(1);
    expect(secondEntries).toHaveLength(0);
    expect(process.listenerCount('unhandledRejection')).toBe(0);
  });

  it("resolves 'auto' to exit when nothing else owns the crash", () => {
    const { capture } = build({ exceptions: { processCrashes: { enabled: true } } });
    capture.onModuleInit();
    expect(capture.resolvedExitMode).toBe('exit');
    capture.onModuleDestroy();
  });

  it("resolves 'auto' to passthrough when the host already has a handler", () => {
    const hostHandler = (): void => undefined;
    process.on('uncaughtException', hostHandler);
    try {
      const { capture } = build({ exceptions: { processCrashes: { enabled: true } } });
      capture.onModuleInit();
      // The host was already deciding whether the process dies. Telescope must
      // not yank the exit out from under it.
      expect(capture.resolvedExitMode).toBe('passthrough');
      capture.onModuleDestroy();
    } finally {
      process.removeListener('uncaughtException', hostHandler);
    }
  });

  it("reproduces Node's fatal exit after recording, in exit mode", async () => {
    const exits: unknown[] = [];
    const written: string[] = [];
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      exits.push(code);
      // Unconditionally throwing keeps the mock's inferred return type `never`
      // (matching process.exit) without a type assertion; the handler's boundary
      // catch swallows it.
      throw new Error('process.exit');
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    const { capture, service, storage } = build({
      exceptions: { processCrashes: { enabled: true, onCrash: 'exit', exitCode: 7 } },
    });
    capture.onModuleInit();
    expect(capture.resolvedExitMode).toBe('exit');

    process.emit('uncaughtException', new RangeError('fatal'));
    await settle();

    const entries = await exceptions(service, storage);
    capture.onModuleDestroy();

    // Recorded FIRST, then the process is taken down exactly as Node would.
    expect(entries).toHaveLength(1);
    expect(exits).toEqual([7]);
    expect(written.join('')).toContain('RangeError: fatal');
    expect(written.join('')).toContain('uncaughtException');
  });

  it('never lets a failure inside the recording path mask the crash', async () => {
    const exits: unknown[] = [];
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      exits.push(code);
      throw new Error('process.exit');
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { capture, service } = build({
      exceptions: { processCrashes: { enabled: true, onCrash: 'exit' } },
    });
    vi.spyOn(service, 'record').mockImplementation(() => {
      throw new Error('storage exploded');
    });
    capture.onModuleInit();

    process.emit('uncaughtException', new Error('the real error'));
    await settle();
    capture.onModuleDestroy();

    // The entry is lost, which is acceptable. The exit contract still runs,
    // which is not negotiable — a broken recorder must not turn a crash into a
    // silently surviving process.
    expect(exits).toEqual([1]);
  });

  it('bounds the flush so a wedged storage cannot hang a dying process', async () => {
    const exits: unknown[] = [];
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      exits.push(code);
      throw new Error('process.exit');
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { capture, service } = build({
      exceptions: { processCrashes: { enabled: true, onCrash: 'exit', flushTimeoutMs: 10 } },
    });
    // A storage provider that never settles: without the bounded race this
    // awaits forever and the process neither reports nor dies.
    vi.spyOn(service, 'flush').mockImplementation(() => new Promise<void>(() => undefined));
    capture.onModuleInit();

    process.emit('uncaughtException', new Error('wedged'));
    await settle(80);
    capture.onModuleDestroy();

    expect(exits).toEqual([1]);
  });

  it('does not recurse when the recording path itself crashes', async () => {
    const { capture, service } = build(passthroughOptions());
    let recordCalls = 0;
    vi.spyOn(service, 'record').mockImplementation(() => {
      recordCalls += 1;
      // Re-enter the handler from inside the handler, the way a rejecting
      // storage write would. The latch must stop this after the first pass.
      process.emit('uncaughtException', new Error('secondary'));
      throw new Error('primary recording failed');
    });
    capture.onModuleInit();

    process.emit('uncaughtException', new Error('primary'));
    await settle();
    capture.onModuleDestroy();

    expect(recordCalls).toBe(1);
  });
});
