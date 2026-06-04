// packages/events/src/events.watcher.ts
import {
  EntryType,
  type RecordInput,
  type Watcher,
  type WatcherContext,
} from '@dudousxd/nestjs-telescope';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

/**
 * The structural surface we need from `@nestjs/event-emitter`'s `EventEmitter2`.
 * Kept minimal so we never import the package directly (it's an optional peer)
 * and so version drift can't break the wrap.
 */
export interface EventEmitterLike {
  onAny(listener: (event: unknown, ...values: unknown[]) => void): unknown;
  offAny?(listener: (event: unknown, ...values: unknown[]) => void): unknown;
  listenerCount?(event?: unknown): number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Narrows a resolved provider to something with a usable `onAny`. */
function hasOnAny(value: unknown): value is EventEmitterLike {
  return isRecord(value) && typeof value.onAny === 'function';
}

/**
 * Captures every event emitted through `@nestjs/event-emitter`'s `EventEmitter2`
 * and records an `EntryType.Event` entry per emit, correlated to the active
 * request/job batch.
 *
 * ## How it works
 * At registration the watcher resolves the singleton `EventEmitter2` from the
 * Nest container (`ctx.moduleRef.get(EventEmitter2, { strict: false })`) and
 * attaches a wildcard listener via `emitter.onAny(...)`. Each emit records
 * `{ name, payload, listenerCount }` where `payload` is the single emitted value
 * (or the array of values when several were emitted). Payload redaction is
 * applied downstream by the Recorder.
 *
 * The listener runs in the emitter's async context, so the entry lands in the
 * request/job batch that triggered the emit — no batch is opened here.
 *
 * ## Resilience
 * If `@nestjs/event-emitter`/`EventEmitter2` isn't available, or the resolved
 * provider has no `onAny`, the watcher logs a warning and no-ops — it never
 * throws. Registration is idempotent (a guard flag), so repeated `register`
 * calls attach the wildcard listener exactly once.
 */
export class EventsWatcher implements Watcher {
  readonly type = EntryType.Event;
  private readonly logger = new Logger(EventsWatcher.name);
  private registered = false;
  private emitter: EventEmitterLike | null = null;
  private listener: ((event: unknown, ...values: unknown[]) => void) | null = null;

  register(ctx: WatcherContext): void {
    if (this.registered) return;
    this.registered = true;

    const emitter = this.resolveEmitter(ctx);
    if (!emitter) {
      this.logger.warn(
        'EventsWatcher: EventEmitter2 (@nestjs/event-emitter) not found or has no onAny(). ' +
          'Events will not be captured.',
      );
      return;
    }

    const watcher = this;
    const listener = function onAnyEvent(event: unknown, ...values: unknown[]): void {
      watcher.safeRecord(ctx, emitter, event, values);
    };
    this.emitter = emitter;
    this.listener = listener;

    try {
      emitter.onAny(listener);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`EventsWatcher: failed to attach wildcard listener: ${message}`);
    }
  }

  /** Detach the wildcard listener if the emitter supports `offAny`. Safe to call
   *  when never registered or when `offAny` is missing. */
  cleanup(): void {
    if (!this.emitter || !this.listener) return;
    if (typeof this.emitter.offAny === 'function') {
      try {
        this.emitter.offAny(this.listener);
      } catch {
        // best-effort detach; never throw on cleanup
      }
    }
    this.emitter = null;
    this.listener = null;
  }

  /** Resolve the singleton `EventEmitter2` from the Nest container; null when the
   *  optional peer isn't wired or the provider isn't an emitter. Defensive: a
   *  missing/strict-resolution throw degrades to null (never propagates). */
  private resolveEmitter(ctx: WatcherContext): EventEmitterLike | null {
    try {
      const found = ctx.moduleRef.get(EventEmitter2, { strict: false });
      return hasOnAny(found) ? found : null;
    } catch {
      return null;
    }
  }

  /** Build + record an event entry, swallowing any failure so a telescope error
   *  can never break event emission. */
  private safeRecord(
    ctx: WatcherContext,
    emitter: EventEmitterLike,
    event: unknown,
    values: unknown[],
  ): void {
    try {
      const name = String(event);
      const payload = values.length === 1 ? values[0] : values;
      const listenerCount =
        typeof emitter.listenerCount === 'function' ? emitter.listenerCount(event) : null;

      const input: RecordInput = {
        type: EntryType.Event,
        familyHash: `event:${name}`,
        tags: ['event', `event:${name}`],
        content: { name, payload, listenerCount },
      };
      ctx.record(input);
    } catch (recordError) {
      const message = recordError instanceof Error ? recordError.message : String(recordError);
      this.logger.error(`EventsWatcher: failed to record event: ${message}`);
    }
  }
}
