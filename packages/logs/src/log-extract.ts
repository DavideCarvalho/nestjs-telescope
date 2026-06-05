// packages/logs/src/log-extract.ts

/**
 * Logger contexts that originate inside Telescope itself. Recording from these
 * is skipped so the watcher never records its own output and never feeds an
 * infinite loop (a recorded log that triggers a log that records ...). Kept
 * small and prefix-matched — see {@link isInternalContext}.
 *
 * Shared by both capture paths ({@link TelescopeConsoleLogger}'s sink and the
 * auto-patched `Logger.prototype`) so the filter is identical regardless of how
 * the host wires logging.
 */
const INTERNAL_CONTEXT_PREFIXES = [
  'Telescope',
  'Recorder',
  'LogsWatcher',
  'EventsWatcher',
] as const;

/** True when a logger context belongs to Telescope's own internals. */
export function isInternalContext(context: string | null): boolean {
  if (context === null) return false;
  return INTERNAL_CONTEXT_PREFIXES.some((prefix) => context.startsWith(prefix));
}

/**
 * Nest's logger convention: the last `optionalParams` entry is the context
 * string (set by a trailing `context` arg, e.g. `logger.log('msg', 'Ctx')` or
 * `logger.error('msg', stack, 'Ctx')`). Read it off the tail without disturbing
 * the normal log call. Returns `null` when no trailing string is present.
 */
export function contextFromParams(params: unknown[]): string | null {
  const last = params.length > 0 ? params[params.length - 1] : undefined;
  return typeof last === 'string' ? last : null;
}

/**
 * Stringify a Nest log message argument for the captured Log entry. Conservative
 * and never-throwing: a string passes through, an `Error` yields its message,
 * objects are JSON best-effort, and anything else falls back to `String(...)`.
 */
export function messageToString(message: unknown): string {
  if (typeof message === 'string') return message;
  if (message instanceof Error) return message.message;
  try {
    return JSON.stringify(message) ?? String(message);
  } catch {
    // Circular / non-serializable value — String() never throws here.
    return String(message);
  }
}
