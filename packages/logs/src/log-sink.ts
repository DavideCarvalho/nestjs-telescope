// packages/logs/src/log-sink.ts

/**
 * A captured log line forwarded from {@link TelescopeConsoleLogger} to the
 * watcher-installed sink. `level` is the Nest log level; `message` is the
 * stringified message; `context` is the logger context (`null` when none).
 */
export interface LogSinkInput {
  level: string;
  message: string;
  context: string | null;
}

type LogSink = (input: LogSinkInput) => void;

let sink: LogSink | null = null;

/**
 * Module-level re-entrancy flag shared by both capture paths (the auto-patched
 * `Logger.prototype` in {@link LogsWatcher} and the {@link TelescopeConsoleLogger}
 * sink). It exists for two reasons:
 *
 *  1. **Loop guard.** Recording a log can itself log (e.g. a failed `ctx.record`
 *     logs an error through `new Logger(...)`, which hits the patched prototype
 *     again). The flag short-circuits the nested record so a single host log
 *     can't spiral into infinite recursion.
 *  2. **Double-record guard.** When the host runs `TelescopeConsoleLogger`
 *     *behind* the Nest `Logger` facade, one logical `logger.log(...)` reaches
 *     both the patched prototype AND the console-logger sink. The auto-patch sets
 *     this flag around the original (which is what eventually calls the console
 *     logger), so the sink sees the flag set and skips — the call records exactly
 *     once, on the auto-patch path.
 *
 * It's a plain boolean rather than AsyncLocalStorage on purpose: Nest's logger
 * calls are fully synchronous, so the flag is set and cleared within one
 * synchronous frame and never leaks across async boundaries.
 * @internal
 */
let recordingInProgress = false;

/** True while a log is being captured (either path). The console-logger sink
 *  reads this to avoid double-recording a facade call already handled by the
 *  auto-patch. @internal */
export function isTelescopeRecordingLog(): boolean {
  return recordingInProgress;
}

/**
 * Run `fn` with the re-entrancy flag set, restoring the previous value after.
 * Nested calls see the flag already set and self-suppress. Never throws on the
 * caller's behalf — `fn`'s own throw still propagates, but the flag is always
 * cleared first (try/finally). @internal
 */
export function withTelescopeLogRecording<T>(fn: () => T): T {
  const previous = recordingInProgress;
  recordingInProgress = true;
  try {
    return fn();
  } finally {
    recordingInProgress = previous;
  }
}

/**
 * Install (or clear, with `null`) the log sink. Called by {@link LogsWatcher}'s
 * `register` lifecycle — hosts and devs should not call this directly.
 * @internal
 */
export function setTelescopeLogSink(fn: LogSink | null): void {
  sink = fn;
}

/**
 * Forward a captured log line to the installed sink. A no-op until
 * {@link LogsWatcher} has wired the sink (so logging through
 * {@link TelescopeConsoleLogger} outside a Telescope-enabled app never crashes
 * and never records).
 * @internal
 */
export function emitTelescopeLog(input: LogSinkInput): void {
  sink?.(input);
}
