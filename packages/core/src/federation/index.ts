// packages/core/src/federation/index.ts
export * from './config.js';
export {
  FederatedStorage,
  decodeMergedCursor,
  encodeMergedCursor,
  isFederatedStorage,
  mergeAggregates,
  mergeRollups,
} from './federated-storage.js';
export {
  type FederationMember,
  type FederationScope,
  activeFederationScope,
  federationScopeOf,
  withFederationScope,
} from './scope.js';
