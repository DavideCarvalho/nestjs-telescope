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
 * tick as an uncaught exception, which would turn an observability bug into a crash.
 *
 * ## Registration
 * Registering the same context again is a no-op. One instance registered by two apps (a shared
 * singleton; `officialWatchers()` returns fresh instances, which is preferred) subscribes once
 * and records into both apps' contexts, just as two separate instances would. `unregister()`
 * (called by Telescope on application shutdown) is reference-counted: `unregister()` takes no
 * context, so it cannot tell which app left, and the handlers stay subscribed (recording into
 * every registered context; a failure to record into a closed one is swallowed) until the last
 * registrar unregisters. A leaving app never stops another app's recording.
 */
export class ChannelWatcher implements Watcher {
  private handlers: [string, (message: unknown) => void][] = [];
  /** Every context registered since the last full teardown; `contexts.length` is the refcount. */
  private contexts: WatcherContext[] = [];
  /** Registrars that have unregistered since the last full teardown. */
  private left = 0;

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
    if (this.contexts.includes(ctx)) return;
    this.contexts.push(ctx);
    if (this.handlers.length > 0) return;
    for (const name of this.channels) {
      const handler = (message: unknown): void => {
        let input: RecordInput | null;
        try {
          input = this.map(name, message);
        } catch {
          // Never let a payload Telescope can't read reach the publisher (or Node's uncaught path).
          return;
        }
        if (input === null) return;
        const app = appOfEvent(message);
        if (app !== null && !(input.tags ?? []).some((tag) => tag.startsWith('app:'))) {
          input = { ...input, tags: [...(input.tags ?? []), `app:${app}`] };
        }
        // Channels publish on completion: a mapped duration walks createdAt back to the start.
        if (input.startedAt === undefined && typeof input.durationMs === 'number') {
          input.startedAt = new Date(Date.now() - Math.max(0, input.durationMs));
        }
        for (const target of this.contexts) {
          try {
            target.record(input);
          } catch {
            // A failing (or closed) context must not reach the publisher nor starve the others.
          }
        }
      };
      diagnostics_channel.subscribe(name, handler);
      this.handlers.push([name, handler]);
    }
  }

  /** Drops one registration; unsubscribes every handler once the last registrar has left. */
  unregister(): void {
    this.left += 1;
    if (this.left < this.contexts.length) return;
    this.contexts = [];
    this.left = 0;
    for (const [name, handler] of this.handlers) diagnostics_channel.unsubscribe(name, handler);
    this.handlers = [];
  }
}

/** An app name an event may carry (the partition syntax). */
const APP_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * The app an event is about: the `app` of a `@dudousxd/nestjs-diagnostics` envelope (`{ lib,
 * event, payload, app? }`), else its payload's (or a bare payload's) `app`. Read structurally, so
 * no diagnostics version is required; `null` when none is a valid app name. The entry is then
 * tagged `app:<name>`: the local console's App picker lists it, and a tenant with `relay: true`
 * (and a token allowed to relay) gets it stored as that app on its control plane.
 */
export function appOfEvent(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return null;
  const record = message as { app?: unknown; payload?: unknown };
  if (typeof record.app === 'string' && APP_NAME.test(record.app)) return record.app;
  const payload = record.payload;
  if (typeof payload === 'object' && payload !== null) {
    const app = (payload as { app?: unknown }).app;
    if (typeof app === 'string' && APP_NAME.test(app)) return app;
  }
  return null;
}

/** `nestjs:<lib>:<type>` → `<type>`. */
export function eventOf(channel: string): string {
  const second = channel.indexOf(':', channel.indexOf(':') + 1);
  return second === -1 ? channel : channel.slice(second + 1);
}
