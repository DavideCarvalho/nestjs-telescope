// packages/logs/src/index.ts
export { LogsWatcher } from './logs.watcher.js';
export type { LogsWatcherOptions } from './logs.watcher.js';
export { TelescopeConsoleLogger } from './telescope-console.logger.js';
export { setTelescopeLogSink, emitTelescopeLog } from './log-sink.js';
export type { LogSinkInput } from './log-sink.js';
