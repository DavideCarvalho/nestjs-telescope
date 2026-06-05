// packages/logs/src/logs.watcher.ts
import {
  EntryType,
  type RecordInput,
  type Watcher,
  type WatcherContext,
} from '@dudousxd/nestjs-telescope';
import { Logger } from '@nestjs/common';
import { contextFromParams, isInternalContext, messageToString } from './log-extract.js';
import {
  type LogSinkInput,
  isTelescopeRecordingLog,
  setTelescopeLogSink,
  withTelescopeLogRecording,
} from './log-sink.js';

/** Options for {@link LogsWatcher}. All optional — the zero-arg form
 *  (`new LogsWatcher()`) keeps the original contract: it still wires the
 *  {@link TelescopeConsoleLogger} sink AND now also auto-patches the facade. */
export interface LogsWatcherOptions {
  /**
   * Auto-patch the `@nestjs/common` `Logger` facade so logs are captured with no
   * host changes (the zero-config path). Default `true`. Set `false` to capture
   * *only* via an explicitly installed {@link TelescopeConsoleLogger}.
   */
  autoPatch?: boolean;
  /** Extra tags appended to every recorded log entry (in addition to the
   *  built-in `log` / `log:<level>` tags). */
  tags?: readonly string[];
}

/** The `Logger.prototype` methods we tee. `fatal` only exists on Nest 10.2+, so
 *  we patch it conditionally (presence-checked at register time). */
const PATCHABLE_LEVELS = ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const;
type PatchableLevel = (typeof PATCHABLE_LEVELS)[number];

/** A Nest logger method: a message plus trailing optional params (stack /
 *  context). We never inspect the params beyond the trailing context string. */
type LoggerMethod = (message: unknown, ...optionalParams: unknown[]) => void;

/** Marks `Logger.prototype` as already teed so we patch exactly once
 *  process-wide. `Symbol.for` (the global registry) is deliberate: two
 *  `LogsWatcher` instances — or two copies of this package loaded side by side —
 *  resolve the same symbol and so observe the same marker, and neither
 *  double-wraps the other's wrapper. */
const PATCHED = Symbol.for('@dudousxd/nestjs-telescope:loggerPatched');

/** The slice of `Logger.prototype` we read/write: the level methods (each
 *  possibly absent, e.g. `fatal` on older Nest) plus our idempotency marker.
 *  Indexing the real `Logger` class type by these string keys isn't structurally
 *  allowed, so we view the prototype through this precise record instead. */
type PatchablePrototype = { [Level in PatchableLevel]?: LoggerMethod } & {
  [PATCHED]?: boolean;
};

/**
 * Captures Nest `Logger` output and records each line as an `EntryType.Log`
 * entry, correlated to the active request/job batch.
 *
 * ## Two capture paths (and why they coexist)
 *
 * 1. **Auto-patch (default, zero-config).** `register` tees the
 *    `@nestjs/common` `Logger.prototype` methods: each patched method calls the
 *    original first (host behavior — console output, any custom logger behind the
 *    facade — is untouched) and then records a telescope entry. This captures
 *    both `new Logger(Ctx)` instance logs and the `Logger.log(...)` statics
 *    (which delegate to a shared instance whose prototype is patched).
 *
 * 2. **Explicit `TelescopeConsoleLogger`.** For hosts that bypass the facade
 *    (logging straight through their app logger), installing
 *    `TelescopeConsoleLogger` forwards lines to a module-level sink that
 *    `register` wires to `ctx.record`.
 *
 * Both run in the caller's async context, so each captured line lands in the
 * request/job batch that produced it — no batch is opened here. When *both* are
 * active (a `TelescopeConsoleLogger` behind the patched facade), a shared
 * re-entrancy flag makes a single logical log record exactly once — see
 * {@link withTelescopeLogRecording} in log-sink.ts.
 *
 * ## Resilience
 * - The prototype patch is idempotent process-wide (a `Symbol.for` marker) and
 *   the sink is wired exactly once per instance (a guard flag).
 * - If `ctx.record` throws, the failure is swallowed so a telescope error can
 *   never break the host's logging.
 * - Telescope's own log contexts (`Telescope`, `Recorder`, ...) are filtered
 *   out, and the same re-entrancy flag guards against an infinite loop where a
 *   failed record logs an error that would itself be captured.
 */
export class LogsWatcher implements Watcher {
  readonly type = EntryType.Log;
  private readonly logger = new Logger(LogsWatcher.name);
  private readonly autoPatch: boolean;
  private readonly extraTags: readonly string[];
  private registered = false;

  constructor(options: LogsWatcherOptions = {}) {
    this.autoPatch = options.autoPatch ?? true;
    this.extraTags = options.tags ?? [];
  }

  register(ctx: WatcherContext): void {
    if (this.registered) return;
    this.registered = true;

    // Always wire the sink so an explicitly installed TelescopeConsoleLogger
    // keeps working (covers hosts that bypass the Logger facade).
    setTelescopeLogSink((input) => {
      this.safeRecord(ctx, input);
    });

    if (this.autoPatch) {
      this.patchLoggerPrototype(ctx);
    }
  }

  /** Clear the sink (e.g. on shutdown) so the console logger no longer records.
   *  The prototype patch is intentionally not reverted — like the HTTP-client
   *  fetch wrapper, it's an always-on, idempotent global appropriate for an
   *  observability tool; reverting it would race with concurrent log calls. */
  cleanup(): void {
    setTelescopeLogSink(null);
    this.registered = false;
  }

  /** Tee the `@nestjs/common` `Logger.prototype` methods: call the original,
   *  then record. Idempotent process-wide via the {@link PATCHED} marker. */
  private patchLoggerPrototype(ctx: WatcherContext): void {
    // View the prototype through the precise {@link PatchablePrototype} record so
    // the level keys index cleanly (the `Logger` class type doesn't allow string
    // indexing). The one hop through `unknown` mirrors the codebase's narrow
    // marker-pattern (see http-client.watcher.ts).
    const prototype = Logger.prototype as unknown as PatchablePrototype;
    if (prototype[PATCHED]) return;
    prototype[PATCHED] = true;

    const watcher = this;
    for (const level of PATCHABLE_LEVELS) {
      const originalMethod = prototype[level];
      // `fatal` is absent before Nest 10.2 — skip cleanly rather than wrap undefined.
      if (typeof originalMethod !== 'function') continue;

      const patched = function patchedLevel(
        this: { context?: string },
        message: unknown,
        ...optionalParams: unknown[]
      ): void {
        // Already inside a capture? This is a nested log — e.g. our own
        // `safeRecord` failure logging an error, which re-enters here. Call the
        // original so the host still sees the line, but DON'T record: that's the
        // re-entrancy guard that breaks the record→log→record loop.
        if (isTelescopeRecordingLog()) {
          originalMethod.call(this, message, ...optionalParams);
          return;
        }
        // Set the flag around the ORIGINAL too: if a TelescopeConsoleLogger sits
        // behind the facade, its sink sees the flag and skips, so a single
        // logical log records exactly once (here, not in the sink).
        withTelescopeLogRecording(() => {
          originalMethod.call(this, message, ...optionalParams);
          watcher.recordFromFacade(ctx, level, message, optionalParams, this.context ?? null);
        });
      };
      prototype[level] = patched;
    }
  }

  /** Build a {@link LogSinkInput} from a facade call and record it. Extraction
   *  is conservative and never throws (it runs inside {@link safeRecord}'s
   *  try/catch): the trailing string param wins as context, else the logger's
   *  own `this.context`, else null. Telescope-internal contexts are dropped. */
  private recordFromFacade(
    ctx: WatcherContext,
    level: PatchableLevel,
    message: unknown,
    optionalParams: unknown[],
    instanceContext: string | null,
  ): void {
    const context = contextFromParams(optionalParams) ?? instanceContext;
    if (isInternalContext(context)) return;
    this.safeRecord(ctx, { level, message: messageToString(message), context });
  }

  /** Build + record a log entry, swallowing any failure so a telescope error can
   *  never break the host's logging. Tags mark the level so warns/errors stay
   *  filterable and survive level-aware `keepErrors` tail-sampling in core. */
  private safeRecord(ctx: WatcherContext, input: LogSinkInput): void {
    try {
      const recordInput: RecordInput = {
        type: EntryType.Log,
        familyHash: `log:${input.level}:${input.context ?? ''}`,
        tags: ['log', `log:${input.level}`, ...this.extraTags],
        content: {
          level: input.level,
          message: input.message,
          context: input.context,
        },
      };
      ctx.record(recordInput);
    } catch (recordError) {
      const message = recordError instanceof Error ? recordError.message : String(recordError);
      this.logger.error(`LogsWatcher: failed to record log entry: ${message}`);
    }
  }
}
