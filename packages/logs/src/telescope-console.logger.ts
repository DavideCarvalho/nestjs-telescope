// packages/logs/src/telescope-console.logger.ts
import { ConsoleLogger } from '@nestjs/common';
import { contextFromParams, isInternalContext, messageToString } from './log-extract.js';
import { emitTelescopeLog, isTelescopeRecordingLog } from './log-sink.js';

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
      // If the auto-patched `Logger.prototype` is already recording this same
      // facade call, skip the sink so one logical log records exactly once
      // (see the flag's doc in log-sink.ts).
      if (isTelescopeRecordingLog()) return;
      const context = contextFromParams(optionalParams) ?? this.context ?? null;
      if (isInternalContext(context)) return;
      emitTelescopeLog({ level, message: messageToString(message), context });
    } catch {
      // best-effort capture; logging must never fail because of Telescope
    }
  }
}
