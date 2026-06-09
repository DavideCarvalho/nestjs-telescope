// packages/inertia-watcher/src/inertia.watcher.ts
import diagnostics_channel from 'node:diagnostics_channel';
import { EntryType, type Watcher, type WatcherContext } from '@dudousxd/nestjs-telescope';
import { buildInertiaContent, isInertiaDiagnostic } from './inertia-content.js';

/**
 * The channel name is the cross-repo contract with `@dudousxd/nestjs-inertia`
 * (exported there as `INERTIA_DIAG_CHANNEL`). Hardcoded here — telescope must NOT
 * import inertia at runtime. Keep this string byte-identical on both sides.
 */
const INERTIA_CHANNEL = 'nestjs-inertia:render';

/**
 * Records every Inertia response published on the `nestjs-inertia:render`
 * diagnostics channel as one `inertia` entry, correlated to the active
 * request/job batch.
 *
 * ## How it works
 * On `register` the watcher subscribes a listener to the channel. `inertia`
 * publishes synchronously inside `InertiaService.render()`, so the listener runs
 * on the same call stack / async context as the render — `ctx.record(...)` lands
 * in the request's ALS batch (no batch is opened here, no request-id plumbing).
 * Subscribing also flips inertia's `channel.hasSubscribers` to `true`, which is
 * what makes the producer start building + publishing payloads at all.
 *
 * ## Resilience
 * Each message is structurally validated (`isInertiaDiagnostic`, `v === 1`);
 * malformed or wrong-version payloads are dropped. All recording is wrapped so a
 * telescope error can never break a render. Registration is idempotent.
 */
export class InertiaWatcher implements Watcher {
  readonly type = EntryType.Inertia;
  private registered = false;
  private onMessage: ((msg: unknown) => void) | null = null;

  register(ctx: WatcherContext): void {
    if (this.registered) return;
    this.registered = true;

    const channel = diagnostics_channel.channel(INERTIA_CHANNEL);
    this.onMessage = (msg) => this.safeRecord(ctx, msg);
    channel.subscribe(this.onMessage);
  }

  /** Unsubscribe the listener. Safe to call when never registered. */
  cleanup(): void {
    if (this.onMessage) {
      diagnostics_channel.channel(INERTIA_CHANNEL).unsubscribe(this.onMessage);
      this.onMessage = null;
    }
    this.registered = false;
  }

  /** Validate + record, swallowing any failure so a render can never break. */
  private safeRecord(ctx: WatcherContext, msg: unknown): void {
    try {
      if (!isInertiaDiagnostic(msg)) return;
      ctx.record(buildInertiaContent(msg));
    } catch {
      // swallow — telescope must never break an Inertia render
    }
  }
}
