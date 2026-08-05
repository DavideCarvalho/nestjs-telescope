// packages/core/src/nest/watcher-context.factory.ts
import type { ModuleRef } from '@nestjs/core';
import type { ResolvedCoreConfig } from '../config/options.js';
import type { BatchOrigin, RecordInput } from '../entry/entry.js';
import type { ExceptionCaptureDetails } from './exception-capture.js';
import type { TelescopeService } from './telescope.service.js';
import type { BatchHandle, WatcherContext } from './watcher.js';

/** Build the WatcherContext handed to each event-based watcher at registration. */
export function createWatcherContext(
  service: TelescopeService,
  config: ResolvedCoreConfig,
  moduleRef: ModuleRef,
): WatcherContext {
  return {
    record: (input: RecordInput) => service.record(input),
    // Delegated, not reimplemented: the family hash, the 4xx control-flow skip
    // and the entry shape must be identical whether the throw happened on a
    // route or inside a job body, or the exceptions view splits in two.
    recordException: (error: unknown, details?: ExceptionCaptureDetails) =>
      service.recordException(error, details),
    runInBatch: <T>(origin: BatchOrigin, fn: () => Promise<T>) => service.runInBatch(origin, fn),
    beginBatch: (origin: BatchOrigin): BatchHandle => service.beginBatch(origin),
    config,
    moduleRef,
  };
}
