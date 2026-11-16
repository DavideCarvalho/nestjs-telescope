// packages/core/src/discovery/index.ts
export {
  type DiscoveryClientOptions,
  DiscoveryClient,
  discoveryUrl,
  readSnapshot,
  writeSnapshot,
} from './client.js';
export {
  type DiscoveryOptions,
  type ResolvedDiscovery,
  defaultSnapshotPath,
  normalizeAppUrl,
  resolveDiscovery,
} from './config.js';
export {
  DISCOVERY_SLOT,
  type DiscoveredApp,
  type DiscoveryContract,
  type DiscoveryMap,
  type Resolution,
  ServiceDirectory,
  publishDirectory,
} from './directory.js';
export { attachDiscoveryToAxios, rewriteAxiosConfig } from './axios.js';
export { TelescopeDiscoveryController } from './discovery.controller.js';
export { TelescopeDiscovery } from './discovery.service.js';
export {
  DiscoveryError,
  type InstalledRewrite,
  type RewriteOptions,
  installFetchRewrite,
  installNodeHttpRewrite,
  isAppHost,
  rewriteTarget,
} from './rewrite.js';
export {
  type DiscoveryScope,
  DiscoveryPublisher,
  TELESCOPE_DISCOVERY_CAPABILITY,
  buildDiscoveryMap,
  discoveryScopeOf,
} from './server.js';
