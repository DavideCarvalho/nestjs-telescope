// The console's URL for a link from the host app. Re-exported here because `./client` resolves to
// this file — see the package's `exports` map.
export { telescopeConsoleUrl } from './console-url.js';

export {
  TELESCOPE_ACCESS_DENIED_EVENT,
  NO_APPS,
  createTelescopeClient,
  pageApp,
  pageTenant,
  withConsoleScope,
  readAccessDenial,
} from './telescope-client.js';
export type {
  BulkActionName,
  CursorPageRequest,
  JobActionName,
  TagPageOptions,
  TelescopeAccessDenial,
  TelescopeClient,
  TelescopeClientOptions,
} from './telescope-client.js';
export type * from './types.js';
