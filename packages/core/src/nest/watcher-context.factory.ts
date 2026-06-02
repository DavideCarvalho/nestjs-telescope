// packages/core/src/nest/watcher-context.factory.ts
import type { ModuleRef } from '@nestjs/core';
import type { ResolvedCoreConfig } from '../config/options.js';
import type { BatchOrigin, RecordInput } from '../entry/entry.js';
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
    runInBatch: <T>(origin: BatchOrigin, fn: () => Promise<T>) => service.runInBatch(origin, fn),
    beginBatch: (origin: BatchOrigin): BatchHandle => service.beginBatch(origin),
    config,
    moduleRef,
  };
}
