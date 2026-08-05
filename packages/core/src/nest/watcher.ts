// packages/core/src/nest/watcher.ts
import type { ModuleRef } from '@nestjs/core';
import type { ResolvedCoreConfig } from '../config/options.js';
import type { BatchOrigin, RecordInput } from '../entry/entry.js';
import type { ExceptionCaptureDetails } from './exception-capture.js';

/** Handle to an open entry-point batch. */
export interface BatchHandle {
  readonly id: string;
  /** Close the batch (ends the ALS scope if this handle opened one). */
  end(): void;
}

/** Everything a watcher is handed at registration time. */
export interface WatcherContext {
  /** Hand an entry to the Recorder — fire-and-forget, never throws/blocks. */
  record(input: RecordInput): void;
  /**
   * Turn a throw that escaped the unit this watcher wraps into an `exception`
   * entry — the SAME entry the Nest interceptor produces for a route, with the
   * same family hash and the same 4xx control-flow policy.
   *
   * WHY watchers need this at all: a `NestInterceptor` only runs on the Nest
   * execution pipeline, so a job body, a `@Cron` callback or a durable step that
   * throws produced no exception entry — no family, no `new-exception` alert, no
   * AI diagnosis. An entry-point watcher already knows the throw (it catches and
   * re-throws it to record the `failed` status), so it is the right place to
   * open the door.
   *
   * Call it INSIDE the batch scope (`runInBatch`/`beginBatch`) so the exception
   * correlates to the job or run it came from. Fire-and-forget and never throws,
   * exactly like `record` — safe to call immediately before re-throwing the
   * host's error.
   *
   * OPTIONAL only for compatibility: core's `createWatcherContext` always
   * supplies it, so in a real app it is always there. It is declared optional so
   * that hand-rolled `WatcherContext` objects — the fixtures every out-of-repo
   * watcher package has in its specs — keep type-checking against a newer core
   * without an edit. Call it as `ctx.recordException?.(…)` (or behind a `typeof`
   * check) and a watcher stays compatible with an older core too.
   */
  recordException?(error: unknown, details?: ExceptionCaptureDetails): void;
  /** Open a batch and run `fn` inside its ALS scope (entry-point watchers). */
  runInBatch<T>(origin: BatchOrigin, fn: () => Promise<T>): Promise<T>;
  /** Open a batch without a callback scope (caller must `end()` it). */
  beginBatch(origin: BatchOrigin): BatchHandle;
  readonly config: ResolvedCoreConfig;
  readonly moduleRef: ModuleRef;
}

/** A source of entries. Built-ins and community watchers implement this. */
export interface Watcher {
  /** The entry `type` this watcher produces. */
  readonly type: string;
  /** Wire framework hooks; called once during module init. */
  register(ctx: WatcherContext): void | Promise<void>;
  /** Optional cheap pre-filter before constructing an entry. */
  shouldRecord?(candidate: unknown): boolean;
}
