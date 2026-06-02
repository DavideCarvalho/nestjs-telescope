// packages/core/src/nest/watcher.ts
import type { ModuleRef } from '@nestjs/core';
import type { BatchOrigin, RecordInput } from '../entry/entry.js';
import type { ResolvedCoreConfig } from '../config/options.js';

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
