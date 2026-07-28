// packages/ui/src/testing/mock-telescope-client.ts
//
// Test-only. Lives outside `src/client` and `src/react` (the two directories
// `tsconfig.lib.json` publishes) so this never ships in the built package.
//
// Shared `TelescopeClient` test double. Specs across the dashboard build a
// fake client to feed `TelescopeProvider`; before this helper, each spec
// hand-rolled the full member list, and `TelescopeClient` growing a new
// member (e.g. `waterfall`, `armProfile`, `auth`) silently drifted every one
// of those literals out of sync. That drift was invisible because specs were
// excluded from `tsc` — the same gap this file exists to close.
import type { TelescopeClient } from '../client/telescope-client.js';

/**
 * Builds a `TelescopeClient` test double. Every member not supplied via
 * `overrides` throws when called, so a spec exercising a path it didn't
 * anticipate fails loudly (a `TypeError` from `undefined()`, not a quiet
 * pass) instead of silently succeeding.
 */
export function mockTelescopeClient(overrides: Partial<TelescopeClient> = {}): TelescopeClient {
  const unused = async (): Promise<never> => {
    throw new Error('not used');
  };
  const base: TelescopeClient = {
    baseUrl: '',
    entries: unused,
    entry: unused,
    pulse: unused,
    queues: unused,
    timeseries: unused,
    traces: unused,
    waterfall: unused,
    stats: unused,
    tags: unused,
    meta: unused,
    extData: unused,
    serverStats: unused,
    serverStatsHistory: unused,
    health: unused,
    retention: unused,
    prunes: unused,
    prune: unused,
    explain: unused,
    diagnose: unused,
    cachedDiagnosis: unused,
    profilerStatus: unused,
    profiles: unused,
    profile: unused,
    armProfile: unused,
    liveQueues: unused,
    schedulesLive: unused,
    queueCounts: unused,
    queueJobs: unused,
    queueJob: unused,
    queueJobAction: unused,
    queueAction: unused,
    queueEnqueue: unused,
    auth: {
      me: unused,
      login: unused,
      logout: unused,
    },
  };
  return { ...base, ...overrides };
}
