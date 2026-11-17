// packages/core/src/federation/scope.ts
//
// Which stores one console call reads in a federated console, and through which view each. Set
// for the console's calls (the API, the dev tools, the switcher's search); anything else (the
// recorder, the pruner, the alerter) runs outside a scope and only touches this app's own store.
import { AsyncLocalStorage } from 'node:async_hooks';
import { type ConsoleAppSelection, appViewOf } from '../nest/console-app-scope.js';
import { type TenantView, intersectViews } from '../storage/tenant-scoped-storage.js';

/** One store a call reads: this app's own (`app: null`) or a federated app's, through `view`. */
export interface FederationMember {
  app: string | null;
  view: TenantView | null;
}

/** The stores of one console call, and the view the call itself runs in. */
export interface FederationScope {
  /** The call's view: while it is the active one, each member reads through its own `view`. */
  view: TenantView | null;
  members: FederationMember[];
}

interface ScopeState {
  scope: FederationScope;
  open: boolean;
}

const scopes = new AsyncLocalStorage<ScopeState | undefined>();

/**
 * The stores an app selection reads. Every app: this app's store (its own entries, and the ones
 * shipped to it) and every federated store. Some apps: this app's store narrowed to the ones that
 * are not federated (when any is left), and the federated ones selected. The organization view
 * applies to every store; the app tag only to this app's own, where shipped entries carry it.
 */
export function federationScopeOf(
  selection: ConsoleAppSelection,
  tenantView: TenantView | null,
  view: TenantView | null,
  federated: readonly string[],
): FederationScope {
  if (selection.kind === 'none') return { view, members: [] };
  if (selection.kind === 'all') {
    return {
      view,
      members: [
        { app: null, view: tenantView },
        ...federated.map((app) => ({ app, view: tenantView })),
      ],
    };
  }
  const names = new Set(federated);
  const home = selection.ids.filter((id) => !names.has(id));
  const members: FederationMember[] = [];
  if (home.length > 0) {
    members.push({
      app: null,
      view: intersectViews(tenantView, appViewOf({ kind: 'apps', ids: home })),
    });
  }
  for (const id of selection.ids) if (names.has(id)) members.push({ app: id, view: tenantView });
  return { view, members };
}

/** The scope of the running console call, if any. */
export function activeFederationScope(): FederationScope | null {
  const state = scopes.getStore();
  return state?.open ? state.scope : null;
}

/** Opens a scope: `run` executes inside it, `close` ends it (later reads go to this app's store). */
export function openFederationScope(scope: FederationScope): {
  run<T>(fn: () => T): T;
  close(): void;
} {
  const state: ScopeState = { scope, open: true };
  return {
    run: (fn) => scopes.run(state, fn),
    close: () => {
      state.open = false;
    },
  };
}

/** Runs `fn` inside `scope` (`undefined`: unchanged), closing it once `fn` settles. */
export async function withFederationScope<T>(
  scope: FederationScope | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (scope === undefined) return fn();
  const handle = openFederationScope(scope);
  try {
    return await handle.run(fn);
  } finally {
    handle.close();
  }
}
