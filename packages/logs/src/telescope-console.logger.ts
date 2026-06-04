// packages/logs/src/telescope-console.logger.ts
import { ConsoleLogger } from '@nestjs/common';
import { emitTelescopeLog } from './log-sink.js';

/**
 * Logger contexts that originate inside Telescope itself. Logging from these is
 * skipped so the watcher never records its own output and never feeds an
 * infinite loop (a recorded log that triggers a log that records ...). Kept
 * small and prefix-matched — see {@link isInternalContext}.
 */
const INTERNAL_CONTEXT_PREFIXES = [
  'Telescope',
  'Recorder',
  'LogsWatcher',
  'EventsWatcher',
] as const;

/** True when a logger context belongs to Telescope's own internals. */
function isInternalContext(context: string | null): boolean {
  if (context === null) return false;
  return INTERNAL_CONTEXT_PREFIXES.some((prefix) => context.startsWith(prefix));
}

/**
 * Nest's `ConsoleLogger`'s last `optionalParams` entry is conventionally the
 * logger context string (set by `new Logger(MyService.name)` / a trailing
 * `context` arg). Read it off the tail without disturbing the normal log call.
 */
function contextFromParams(params: unknown[]): string | null {
  const last = params.length > 0 ? params[params.length - 1] : undefined;
  return typeof last === 'string' ? last : null;
}

/** Stringify a Nest log message argument for the captured Log entry. */
function messageToString(message: unknown): string {
  if (typeof message === 'string') return message;
  if (message instanceof Error) return message.message;
  try {
    return JSON.stringify(message) ?? String(message);
  } catch {
    return String(message);
  }
}

/**
 * A drop-in `ConsoleLogger` that, in addition to its normal console output,
 * forwards every log line to Telescope's log sink so the {@link LogsWatcher} can
 * record it as a `log` entry.
 *
 * ## Usage
 * The host installs it as the app logger and adds {@link LogsWatcher} to the
 * Telescope watchers:
 *
 * ```ts
 * app.useLogger(new TelescopeConsoleLogger());
 * // ...
 * TelescopeModule.forRoot({ watchers: [new LogsWatcher()] });
 * ```
 *
 * Until `LogsWatcher.register` wires the sink, emitting is a no-op — so using
 * this logger outside a Telescope-enabled app never records (it just logs).
 *
 * Telescope's own log contexts (prefix `Telescope`/`Recorder`) are skipped to
 * avoid recording the library's own output and any feedback loop.
 */
export class TelescopeConsoleLogger extends ConsoleLogger {
  override log(message: unknown, ...optionalParams: unknown[]): void {
    super.log(message, ...optionalParams);
    this.capture('log', message, optionalParams);
  }

  override error(message: unknown, ...optionalParams: unknown[]): void {
    super.error(message, ...optionalParams);
    this.capture('error', message, optionalParams);
  }

  override warn(message: unknown, ...optionalParams: unknown[]): void {
    super.warn(message, ...optionalParams);
    this.capture('warn', message, optionalParams);
  }

  override debug(message: unknown, ...optionalParams: unknown[]): void {
    super.debug(message, ...optionalParams);
    this.capture('debug', message, optionalParams);
  }

  override verbose(message: unknown, ...optionalParams: unknown[]): void {
    super.verbose(message, ...optionalParams);
    this.capture('verbose', message, optionalParams);
  }

  /** Forward a captured line to the sink, skipping Telescope-internal contexts.
   *  Never throws — a sink/serialization failure must not break logging. */
  private capture(level: string, message: unknown, optionalParams: unknown[]): void {
    try {
      const context = contextFromParams(optionalParams) ?? this.context ?? null;
      if (isInternalContext(context)) return;
      emitTelescopeLog({ level, message: messageToString(message), context });
    } catch {
      // best-effort capture; logging must never fail because of Telescope
    }
  }
}
