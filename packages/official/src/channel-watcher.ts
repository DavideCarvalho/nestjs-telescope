// packages/official/src/channel-watcher.ts
import diagnostics_channel from 'node:diagnostics_channel';
import type { RecordInput, Watcher, WatcherContext } from '@dudousxd/nestjs-telescope';

/** Turns one channel message into an entry, or `null` to skip it. */
export type ChannelMapper = (channel: string, message: unknown) => RecordInput | null;

/**
 * A watcher fed by `node:diagnostics_channel` channels.
 *
 * ## Correlation
 * The official packages' payloads carry no trace id. They don't need to: `channel.publish()` calls
 * its subscribers synchronously, in the publisher's async context, so the `ctx.record()` below runs
 * inside the request / job batch that emitted the event, and the recorder stamps the batch and the
 * current trace (`traceContext` — OpenTelemetry, `ObserveTraceContextProvider`, or
 * `@dudousxd/nestjs-context`) exactly as for an entry the app recorded itself.
 *
 * ## Safety
 * A mapper or record failure is swallowed: a subscriber that throws is reported by Node on the next
 * tick as an uncaught exception, which would turn an observability bug into a crash. Subscribing is
 * idempotent; `unregister()` (called by Telescope on application shutdown) drops every handler.
 */
export class ChannelWatcher implements Watcher {
  private handlers: [string, (message: unknown) => void][] = [];

  constructor(
    readonly type: string,
    private readonly channels: readonly string[],
    private readonly map: ChannelMapper,
  ) {}

  /** The channel names this watcher subscribes to. */
  get channelNames(): readonly string[] {
    return this.channels;
  }

  register(ctx: WatcherContext): void {
    if (this.handlers.length > 0) return;
    for (const name of this.channels) {
      const handler = (message: unknown): void => {
        try {
          const input = this.map(name, message);
          if (input !== null) ctx.record(input);
        } catch {
          // Never let a payload Telescope can't read reach the publisher (or Node's uncaught path).
        }
      };
      diagnostics_channel.subscribe(name, handler);
      this.handlers.push([name, handler]);
    }
  }

  unregister(): void {
    for (const [name, handler] of this.handlers) diagnostics_channel.unsubscribe(name, handler);
    this.handlers = [];
  }
}

/** `nestjs:<lib>:<type>` → `<type>`. */
export function eventOf(channel: string): string {
  const second = channel.indexOf(':', channel.indexOf(':') + 1);
  return second === -1 ? channel : channel.slice(second + 1);
}
