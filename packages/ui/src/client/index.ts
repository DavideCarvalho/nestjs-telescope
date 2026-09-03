// Headless console-launcher primitives (path derivation + mint-then-navigate). Re-exported here
// because `./client` resolves to this file — see the package's `exports` map.
export {
  ConsoleSessionError,
  telescopeConsoleSessionUrl,
  telescopeConsoleUrl,
  mintTelescopeConsoleSession,
  openTelescopeConsole,
  type OpenConsoleOptions,
} from './console-session.js';

export { createTelescopeClient } from './telescope-client.js';
export type {
  BulkActionName,
  JobActionName,
  TagPageOptions,
  TelescopeClient,
  TelescopeClientOptions,
} from './telescope-client.js';
export type * from './types.js';
