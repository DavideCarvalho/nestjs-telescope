// packages/core/src/nest/telescope-crash-capture.service.ts
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { ResolvedCoreConfig } from '../config/options.js';
import type { ExceptionContent } from '../entry/content.js';
import { EntryType, type RecordInput } from '../entry/entry.js';
import { exceptionFamilyHash } from '../entry/exception-family-hash.js';
import {
  TELESCOPE_CONFIG,
  TELESCOPE_OPTIONS,
  type TelescopeModuleOptions,
} from './telescope.options.js';
import { TelescopeService } from './telescope.service.js';

/**
 * Which process-level event produced a captured crash. Kept as the literal Node
 * event names so the recorded `content.context.source` reads the same as the
 * thing you'd grep for in Node's docs.
 */
export type ProcessCrashKind = 'unhandledRejection' | 'uncaughtException';

/** Resolved exit behaviour — see {@link TelescopeCrashCapture} for the contract. */
type CrashExitMode = 'exit' | 'passthrough';

/** Tag on every process-level crash entry, so the dashboard can filter the family. */
const CRASH_TAG = 'unhandled';

/**
 * Tag added when the crash could not be attributed to any batch. Recorded
 * EXPLICITLY (rather than dropped or silently attached to a synthetic batch)
 * because "this error belongs to no request/job" is itself the finding.
 */
const ORPHANED_TAG = 'orphaned';

/** Per-kind dashboard tag; kebab-case to match the existing tag vocabulary. */
const KIND_TAG: Record<ProcessCrashKind, string> = {
  unhandledRejection: 'unhandled-rejection',
  uncaughtException: 'uncaught-exception',
};

/** Default budget for the pre-exit flush. See `flushTimeoutMs`. */
const DEFAULT_FLUSH_TIMEOUT_MS = 2000;

/** Node's own fatal exit code, reproduced by `onCrash: 'exit'`. */
const DEFAULT_EXIT_CODE = 1;

/**
 * Process-wide install slot, keyed by a `Symbol.for` on `globalThis` rather than
 * a module-scoped `let`.
 *
 * WHY the global registry and not a module variable: pnpm workspaces, a
 * transitive dependency pinning a different `@dudousxd/nestjs-telescope`, or a
 * test runner that re-imports the ESM graph can all give you TWO live copies of
 * this module — each with its own module scope, each convinced it is the first
 * to install. Two copies means two `process.on` listeners means every crash is
 * recorded TWICE (two entries, two family occurrences, two `new-exception`
 * evaluations). `Symbol.for` is interned per realm, so the second copy sees the
 * first copy's claim and stands down.
 */
const INSTALL_SLOT = Symbol.for('@dudousxd/nestjs-telescope.processCrashCapture');

/**
 * Claim the process-wide install slot for `owner`. Returns false when another
 * instance (possibly from a duplicate copy of this module) already holds it.
 */
function claimInstallSlot(owner: object): boolean {
  const current: unknown = Reflect.get(globalThis, INSTALL_SLOT);
  if (current !== undefined && current !== null) return false;
  return Reflect.set(globalThis, INSTALL_SLOT, owner);
}

/** Release the slot, but only if `owner` is the one holding it. */
function releaseInstallSlot(owner: object): void {
  const current: unknown = Reflect.get(globalThis, INSTALL_SLOT);
  if (current === owner) {
    Reflect.set(globalThis, INSTALL_SLOT, undefined);
  }
}

/**
 * Render an arbitrary rejection reason as a string WITHOUT ever throwing.
 * `Promise.reject(x)` accepts any value, including an object whose `toString`
 * throws — and a throw from inside the crash handler is the worst possible
 * place to have one, because it would replace the host's real error with ours.
 */
function describeReason(reason: unknown): string {
  try {
    return String(reason);
  } catch {
    return '<unstringifiable rejection reason>';
  }
}

/** Coerce whatever came out of the process event into an `Error`. */
function toError(raw: unknown): Error {
  return raw instanceof Error ? raw : new Error(describeReason(raw));
}

/**
 * Build the `exception` RecordInput for a captured error.
 *
 * DELIBERATELY identical in shape and family-hash inputs to what
 * `TelescopeExceptionInterceptor` builds, so a crash and a route-handler throw
 * of the same error land in the SAME family and the `new-exception` alert dedups
 * across both sources. A sibling change is extracting exactly this into a shared
 * capture helper in this directory; when it lands, delete this function and call
 * that one instead — the single call site in `capture()` below is the only edit
 * needed, which is why the shape is factored out here rather than inlined.
 */
function crashRecordInput(
  error: Error,
  kind: ProcessCrashKind,
  orphaned: boolean,
): RecordInput<ExceptionContent> {
  const tags = [CRASH_TAG, KIND_TAG[kind], 'failed'];
  if (orphaned) tags.push(ORPHANED_TAG);
  return {
    type: EntryType.Exception,
    familyHash: exceptionFamilyHash({
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
    }),
    tags,
    content: {
      class: error.name,
      message: error.message,
      stack: error.stack ?? null,
      context: { source: kind, orphaned },
    },
  };
}

/**
 * Records `process.on('unhandledRejection')` and `process.on('uncaughtException')`
 * as telescope `exception` entries. **Opt-in** via
 * `exceptions.processCrashes.enabled` — off by default.
 *
 * WHY this exists: before it, the ONLY server-side exception source was
 * {@link TelescopeExceptionInterceptor}, which lives on the Nest pipeline. A
 * promise rejected with nobody awaiting it, or a throw from a timer / stream
 * callback / event emitter, never touches that pipeline — so it produced no
 * entry, no exception family, and no `new-exception` alert. Those are precisely
 * the failures that take the process down: the incident with the least
 * observability was the one that ended the process.
 *
 * WHY opt-in and not on by default: attaching a process-level listener CHANGES
 * THE HOST'S CRASH SEMANTICS. Node's default for an `uncaughtException` is to
 * print the stack and exit(1); the moment ANY listener is registered that
 * default is suppressed and the process keeps running. The same is true for
 * `unhandledRejection` under Node's default `--unhandled-rejections=throw`. A
 * library that attached these behind the host's back would silently convert
 * "crashed, restarted clean by the orchestrator" into "limping along with
 * half-initialised state" — a strictly worse failure mode than the one it was
 * trying to observe. So the host has to ask for it, in writing.
 *
 * ## The exit contract
 *
 * Telescope never decides on its own whether your process dies. After the entry
 * is recorded and the bounded flush has settled:
 *
 * - `onCrash: 'exit'` — reproduce Node's default: write the stack to stderr and
 *   `process.exit(1)` (`exitCode` is configurable). Use this when Telescope is
 *   the only process-level listener, i.e. when the process WOULD have died.
 * - `onCrash: 'passthrough'` — record only, then return. The host's own handler
 *   (or an APM agent's) decides what happens next. Use this ONLY when something
 *   else already owns the crash, otherwise you have converted a crash into a
 *   zombie.
 * - `onCrash: 'auto'` (the default) — decide at registration time by counting
 *   PRE-EXISTING listeners for the two events. Zero listeners means nothing else
 *   was deciding and Node would have crashed, so Telescope reproduces that
 *   (`'exit'`). One or more means the host was already deciding, so Telescope
 *   defers (`'passthrough'`) rather than yanking the exit out from under an
 *   existing handler. The decision is logged at boot, once.
 *
 * `'auto'` samples the listener count at `onModuleInit`. A host that registers
 * its own handler AFTER Nest bootstrap must therefore pass `onCrash` explicitly
 * — auto will already have picked `'exit'` and will race the late handler to
 * the exit. The boot log line tells you which mode is live.
 *
 * To keep Node's ORIGINAL crash behaviour exactly: leave `onCrash` at `'auto'`
 * (or set `'exit'`) and register no competing handler, or — the belt-and-braces
 * version — register your own handler that exits, and let Telescope run in
 * `'passthrough'`.
 *
 * ## Recording is best-effort and bounded
 *
 * The process may be milliseconds from death, so the flush is raced against
 * `flushTimeoutMs` (default 2s) on an unref'd timer: a wedged storage provider
 * delays the exit by at most that budget instead of hanging a dying process
 * forever. Every step is wrapped so that a failure INSIDE the recording path can
 * never mask or replace the host's original error — the worst case is a missing
 * entry, never a swallowed crash.
 */
@Injectable()
export class TelescopeCrashCapture implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelescopeCrashCapture.name);
  /** True once this instance owns the process listeners (drives teardown). */
  private installed = false;
  private exitMode: CrashExitMode = 'passthrough';
  private flushTimeoutMs = DEFAULT_FLUSH_TIMEOUT_MS;
  private exitCode = DEFAULT_EXIT_CODE;
  /**
   * Re-entrancy latch around the SYNCHRONOUS record call. A tagger, redactor or
   * host `filter` that throws — or anything else that raises a crash from
   * inside `record()` — would otherwise re-enter this handler and recurse until
   * the stack gives out, burying the original error under its own failure. The
   * latch is deliberately NOT held across the flush: two genuinely unrelated
   * crashes in the same tick must both be recorded, and holding a mutex for the
   * whole flush budget would silently drop the second one.
   */
  private recording = false;

  /**
   * Bound instance arrow functions, kept as fields so `onModuleDestroy` can pass
   * the SAME references to `removeListener`. A fresh `.bind()` at teardown time
   * would silently remove nothing and leak the listener into the next test file
   * — the classic way this kind of code poisons an unrelated suite.
   */
  /**
   * The `.catch()` on each is the terminator of the loop this class could
   * otherwise become: an error escaping `capture()` would reject a promise
   * nobody awaits, which IS an unhandled rejection, which re-enters this very
   * handler. Swallowing at the boundary means the worst case is a lost entry.
   */
  private readonly onUnhandledRejection = (reason: unknown): void => {
    void this.capture(reason, 'unhandledRejection').catch(() => undefined);
  };

  private readonly onUncaughtException = (error: unknown): void => {
    void this.capture(error, 'uncaughtException').catch(() => undefined);
  };

  constructor(
    @Inject(TelescopeService) private readonly service: TelescopeService,
    @Inject(TELESCOPE_OPTIONS) private readonly options: TelescopeModuleOptions,
    @Inject(TELESCOPE_CONFIG) private readonly config: ResolvedCoreConfig,
  ) {}

  onModuleInit(): void {
    const settings = this.options.exceptions?.processCrashes;
    if (settings?.enabled !== true) return;
    // Capture disabled globally ⇒ every entry would be dropped anyway, and
    // attaching an exit-altering listener purely to no-op is exactly the
    // behind-your-back semantics change this whole design is avoiding.
    if (!this.config.enabled) {
      this.logger.warn(
        'exceptions.processCrashes is enabled but Telescope capture is disabled — ' +
          'process-level crash handlers were NOT registered.',
      );
      return;
    }
    if (!claimInstallSlot(this)) {
      // A second TelescopeModule in the same process (or a duplicate copy of
      // this package) already owns the listeners. Standing down is what keeps
      // one crash from producing two entries.
      this.logger.warn(
        'Process-level crash capture is already installed in this process — ' +
          'this TelescopeModule instance will not register a second set of handlers.',
      );
      return;
    }
    this.flushTimeoutMs = settings.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
    this.exitCode = settings.exitCode ?? DEFAULT_EXIT_CODE;
    this.exitMode = this.resolveExitMode(settings.onCrash ?? 'auto');
    process.on('unhandledRejection', this.onUnhandledRejection);
    process.on('uncaughtException', this.onUncaughtException);
    this.installed = true;
    this.logger.log(
      `Process-level crash capture enabled (onCrash: '${this.exitMode}'` +
        `${this.exitMode === 'exit' ? `, exitCode: ${this.exitCode}` : ''}, ` +
        `flushTimeoutMs: ${this.flushTimeoutMs}).`,
    );
  }

  onModuleDestroy(): void {
    if (!this.installed) return;
    process.removeListener('unhandledRejection', this.onUnhandledRejection);
    process.removeListener('uncaughtException', this.onUncaughtException);
    this.installed = false;
    releaseInstallSlot(this);
  }

  /** Whether this instance currently owns the process listeners. @internal */
  get isInstalled(): boolean {
    return this.installed;
  }

  /** The resolved exit behaviour for this instance. @internal */
  get resolvedExitMode(): CrashExitMode {
    return this.exitMode;
  }

  /**
   * Resolve `'auto'` against the listeners already on the process. Counting
   * BOTH events together is deliberate: a host that handles only
   * `uncaughtException` still demonstrably owns crash policy, and pre-empting it
   * on the rejection side alone would produce two different exit behaviours for
   * what is, under Node's defaults, the same fatal path.
   */
  private resolveExitMode(configured: 'exit' | 'passthrough' | 'auto'): CrashExitMode {
    if (configured !== 'auto') return configured;
    const preexisting =
      process.listenerCount('uncaughtException') + process.listenerCount('unhandledRejection');
    return preexisting === 0 ? 'exit' : 'passthrough';
  }

  /**
   * Record the crash, flush on a bounded budget, then apply the exit contract.
   *
   * Everything up to the first `await` runs SYNCHRONOUSLY inside the process
   * event handler, which is load-bearing: `AsyncLocalStorage` still holds the
   * batch that was active when the promise rejected / the callback threw, so
   * `service.record()` inherits its `batchId`, `origin` and ambient `traceId`
   * for free. Move the `record()` call after an await and every crash becomes
   * orphaned.
   */
  private async capture(raw: unknown, kind: ProcessCrashKind): Promise<void> {
    const error = toError(raw);
    this.recordCrash(error, kind);
    try {
      await this.boundedFlush();
    } catch {
      // boundedFlush already swallows; belt-and-braces so no path from here can
      // throw back into the process handler.
    }
    this.finish(error, kind);
  }

  /**
   * The synchronous half of the capture: read the active batch and hand the
   * entry to the Recorder. Never throws — a failure in OUR path must never
   * replace or hide the host's error, so the worst case is a warning and a
   * missing entry, and the exit contract still runs.
   */
  private recordCrash(error: Error, kind: ProcessCrashKind): void {
    if (this.recording) return;
    this.recording = true;
    try {
      // Read the active batch through the SAME accessor the Recorder will use a
      // line later, so `orphaned` can never disagree with the `batchId` actually
      // stamped on the entry.
      const orphaned = this.service.context.current() === undefined;
      this.service.record(crashRecordInput(error, kind, orphaned));
    } catch (recordingError) {
      const message =
        recordingError instanceof Error ? recordingError.message : describeReason(recordingError);
      this.logger.warn(`Failed to record ${kind} entry: ${message}`);
    } finally {
      this.recording = false;
    }
  }

  /**
   * Race the recorder flush against `flushTimeoutMs` on an UNREF'D timer.
   *
   * Two failure modes are being avoided at once. First, awaiting an unbounded
   * `flush()` in a process that is about to exit turns a crash into a hang if
   * the storage backend is wedged — the timeout caps that at a known budget and
   * we exit with the entry possibly unwritten, which is the right trade for a
   * dying process. Second, the `.catch()` on the flush promise itself is NOT
   * decoration: once the race resolves via timeout, that promise is abandoned,
   * and an abandoned rejecting promise is an unhandled rejection — which would
   * re-enter this very handler. The catch is what stops crash capture from
   * feeding itself.
   */
  private boundedFlush(): Promise<void> {
    const flushed = this.service.flush().catch(() => undefined);
    const budget = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.flushTimeoutMs);
      timer.unref?.();
    });
    return Promise.race([flushed, budget]);
  }

  /**
   * Apply the exit contract. In `'exit'` mode this reproduces what Node would
   * have done with no listener attached: the stack on stderr, then exit(1).
   * `process.stderr.write` rather than the Nest `Logger` so the output survives
   * a custom logger that buffers, filters by level, or ships asynchronously —
   * the last thing written before a fatal exit has to be unconditional.
   */
  private finish(error: Error, kind: ProcessCrashKind): void {
    if (this.exitMode === 'passthrough') return;
    process.stderr.write(`${kind}: ${error.stack ?? `${error.name}: ${error.message}`}\n`);
    process.exit(this.exitCode);
  }
}
