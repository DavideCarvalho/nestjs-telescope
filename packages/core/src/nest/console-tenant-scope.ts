// packages/core/src/nest/console-tenant-scope.ts
//
// The console tenant scope: which organizations' data a console viewer sees. Every Aviary console
// declares it locally with identical names and shapes (no cross-lib import), next to its
// `authorize` contract.
import type { Tenancy, TenantFilter } from '../context/tenancy.js';

/** What `authorize` may grant: `'*'` every tenant (and rows with none), or these tenant ids. */
export type ConsoleTenants = '*' | string[];

/**
 * The tenants a viewer may see, once `authorize` allowed them and the console's tenancy is on.
 * `tenants: []` means none: the console is empty and asks to choose an organization.
 */
export interface ConsoleTenantScope {
  tenants: ConsoleTenants;
  /** The viewer's own tenant (from the context), for its label. */
  own?: { id: string; kind?: string; slug?: string };
}

/** The data one console call answers with, after `?tenant=` met the scope. */
export type ConsoleTenantSelection =
  | { kind: 'all' }
  | { kind: 'tenant'; id: string }
  | { kind: 'none'; forged?: string };

/**
 * Reads `tenants` from an `authorize` result: `'*'`, a list of non-empty ids, or absent. A list
 * naming `'*'` grants every organization, as `'*'` does.
 */
export function consoleTenantsOf(result: unknown): ConsoleTenants | undefined {
  if (typeof result !== 'object' || result === null || !('tenants' in result)) return undefined;
  const tenants = (result as { tenants?: unknown }).tenants;
  if (tenants === '*') return '*';
  if (!Array.isArray(tenants)) return undefined;
  if (tenants.includes('*')) return '*';
  return [...new Set(tenants.filter((id): id is string => typeof id === 'string' && id !== ''))];
}

/** The context's `TenantRequiredError` (`code: 'E_TENANT_REQUIRED'`), read structurally. */
function isTenantRequired(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'E_TENANT_REQUIRED'
  );
}

/**
 * The scope of a viewer `authorize` allowed. `null` when tenancy is off: the console shows
 * everything, as without tenancy. With tenancy on: `tenants` from the result when it has them,
 * otherwise the viewer's own context tenant: the level the configured `kinds` pick (none: an
 * empty scope, or the context's `TenantRequiredError` when the tenancy is `required`).
 */
export function resolveConsoleTenantScope(
  tenancy: Tenancy,
  tenants: ConsoleTenants | undefined,
): ConsoleTenantScope | null {
  if (!tenancy.enabled) return null;
  // A viewer `authorize` grants organizations to needs no tenant of its own; only one granted
  // nothing meets the context's `required` (its TenantRequiredError, a 403). Any other failure is
  // rethrown as it is.
  let filter: TenantFilter;
  let missing: unknown;
  try {
    filter = tenancy.filter();
  } catch (error) {
    if (!isTenantRequired(error)) throw error;
    filter = { mode: 'tenantless' };
    missing = error;
  }
  const own =
    filter.mode === 'tenant'
      ? {
          id: filter.tenant.id,
          kind: filter.tenant.kind,
          ...(filter.tenant.slug !== undefined ? { slug: filter.tenant.slug } : {}),
        }
      : undefined;
  const withOwn = (scope: ConsoleTenantScope): ConsoleTenantScope =>
    own ? { ...scope, own } : scope;
  if (tenants !== undefined) return withOwn({ tenants });
  if (missing !== undefined) throw missing;
  if (filter.mode === 'all') return { tenants: '*' };
  return withOwn({ tenants: own ? [own.id] : [] });
}

/**
 * Meets the `?tenant=` of a call with the scope. Tenancy off: everything, the parameter ignored.
 * `'*'`: everything when no tenant (or `'*'`) is asked for, else that tenant. A list: the asked tenant when it
 * is in the list, the viewer's own (else the first) when none is asked for. A tenant outside the
 * scope is `none` with `forged` set: the call answers empty.
 */
export function selectConsoleTenant(
  scope: ConsoleTenantScope | null,
  requested: unknown,
): ConsoleTenantSelection {
  if (scope === null) return { kind: 'all' };
  const id =
    typeof requested === 'string' && requested !== '' && requested !== '*' ? requested : undefined;
  if (scope.tenants === '*') return id === undefined ? { kind: 'all' } : { kind: 'tenant', id };
  if (id !== undefined) {
    return scope.tenants.includes(id) ? { kind: 'tenant', id } : { kind: 'none', forged: id };
  }
  const fallback =
    scope.own !== undefined && scope.tenants.includes(scope.own.id)
      ? scope.own.id
      : scope.tenants[0];
  return fallback === undefined ? { kind: 'none' } : { kind: 'tenant', id: fallback };
}

/** What `GET <api>/tenancy` answers: the header's "Organization" control. */
export type ConsoleTenancyInfo =
  | { enabled: false }
  | {
      enabled: true;
      /** The authorized scope. `[]`: none, the console asks to choose an organization. */
      tenants: ConsoleTenants;
      /** The tenant this view shows; `null` for all organizations. */
      selected: string | null;
      /** Organizations to pick from (narrowed by `search`), with a label each. */
      options: { id: string; label: string }[];
    };

const decisions = new WeakMap<object, ConsoleTenants | undefined>();

/** Keeps what `authorize` granted for this request, for the scope read after the guard. */
export function rememberConsoleTenants(
  request: unknown,
  tenants: ConsoleTenants | undefined,
): void {
  if (typeof request === 'object' && request !== null) decisions.set(request, tenants);
}

/** What `authorize` granted for this request (`undefined`: no `tenants`, or not seen). */
export function consoleTenantsFor(request: unknown): ConsoleTenants | undefined {
  return typeof request === 'object' && request !== null ? decisions.get(request) : undefined;
}
