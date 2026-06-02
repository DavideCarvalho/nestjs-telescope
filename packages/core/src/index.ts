// packages/core/src/index.ts
export * from './entry/entry.js';
export * from './entry/content.js';
export * from './redaction/redact.js';
export * from './context/batch.js';
export * from './context/telescope-context.js';
export * from './storage/storage-provider.js';
export * from './storage/in-memory-storage-provider.js';
export * from './tagging/tagger.js';
export * from './recorder/recorder.js';
export * from './config/options.js';
export * from './config/resolve-config.js';

export * from './storage/cursor.js';
export * from './storage/safe-json.js';
export * from './storage/sqlite-storage-provider.js';
export * from './nest/watcher.js';
export * from './nest/telescope.options.js';
export * from './nest/telescope.service.js';
export * from './nest/telescope.guard.js';
export * from './nest/telescope.controller.js';
export * from './nest/telescope-pruner.service.js';
export * from './nest/telescope.module.js';

export const TELESCOPE_VERSION = '0.0.0';
