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

export const TELESCOPE_VERSION = '0.0.0';
