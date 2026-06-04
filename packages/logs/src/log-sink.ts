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
