// packages/logs/src/logs.watcher.ts
import {
  EntryType,
  type RecordInput,
  type Watcher,
  type WatcherContext,
} from '@dudousxd/nestjs-telescope';
import { Logger } from '@nestjs/common';
import { type LogSinkInput, setTelescopeLogSink } from './log-sink.js';

/**
 * Captures Nest `Logger` output and records each line as an `EntryType.Log`
 * entry, correlated to the active request/job batch.
 *
 * ## How it works
 * The host installs {@link TelescopeConsoleLogger} as the app logger
 * (`app.useLogger(new TelescopeConsoleLogger())`). That logger forwards every
 * line to a module-level sink; `register` wires that sink to `ctx.record(...)`.
 * Because the logger emits in the caller's async context, each captured line
 * lands in the request/job batch that produced it — no batch is opened here.
 *
 * ## Resilience
 * Registration is idempotent (a guard flag) so the sink is wired exactly once.
 * If `ctx.record` throws, the failure is swallowed so a telescope error can
 * never break the host's logging. Telescope's own log contexts are filtered out
 * in the logger before they ever reach the sink.
 */
export class LogsWatcher implements Watcher {
  readonly type = EntryType.Log;
  private readonly logger = new Logger(LogsWatcher.name);
  private registered = false;

  register(ctx: WatcherContext): void {
    if (this.registered) return;
    this.registered = true;
    setTelescopeLogSink((input) => {
      this.safeRecord(ctx, input);
    });
  }

  /** Clear the sink (e.g. on shutdown) so the logger no longer records. */
  cleanup(): void {
    setTelescopeLogSink(null);
    this.registered = false;
  }

  /** Build + record a log entry, swallowing any failure so a telescope error can
   *  never break the host's logging. */
  private safeRecord(ctx: WatcherContext, input: LogSinkInput): void {
    try {
      const recordInput: RecordInput = {
        type: EntryType.Log,
        familyHash: `log:${input.level}:${input.context ?? ''}`,
        tags: ['log', `log:${input.level}`],
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
