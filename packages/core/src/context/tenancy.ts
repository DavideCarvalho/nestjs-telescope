// packages/core/src/context/tenancy.ts
//
// Local reader for the @dudousxd/nestjs-context tenancy contract. Copied into each lib;
// it imports nothing, so the lib works with any context version or none at all.
export interface TenantLevel {
  id: string;
  kind: string;
  slug?: string;
  role?: string;
}
export interface TenantRef extends TenantLevel {
  source: string;
  chain?: TenantLevel[]; // root first, this tenant last; absent for a flat tenant
  family?: string;
}
export type TenantFilter =
  | { mode: 'system' }
  | { mode: 'all' }
  | { mode: 'tenantless' }
  | { mode: 'tenant'; tenant: TenantRef; chain?: TenantLevel[] }; // `chain`: context >= 2.1
export type TenancyOption =
  | 'inherit'
  | false
  | {
      enabled?: 'inherit' | boolean;
      kinds?: string[];
      family?: string;
      required?: boolean;
      nullRows?: 'tenantless' | 'shared';
    };
export type Tenancy =
  | { enabled: false }
  | { enabled: true; nullRows: 'tenantless' | 'shared'; filter(): TenantFilter };

interface FilterOptions {
  kinds?: string[];
  family?: string;
  required?: boolean;
}
interface Accessor {
  tenancy?(): { enabled: boolean; kinds?: string[]; required?: boolean };
  tenantFilter?(options?: FilterOptions): TenantFilter;
  tenantLabels?(tenants: TenantLevel[]): Promise<Record<string, string>>;
}
const SLOT = Symbol.for('@dudousxd/nestjs-diagnostics:accessor');

function accessorOf(accessor: unknown): Accessor | undefined {
  const slot = (globalThis as unknown as Record<symbol, { current?: unknown } | undefined>)[SLOT];
  return (accessor ?? slot?.current ?? undefined) as Accessor | undefined;
}

/** `accessor`: the `CONTEXT_ACCESSOR` injected with `@Optional()`, if any. Call per operation. */
export function readTenancy(option: TenancyOption = 'inherit', accessor?: unknown): Tenancy {
  const a = accessorOf(accessor);
  if (option === false || typeof a?.tenancy !== 'function' || !a.tenantFilter) {
    return { enabled: false };
  }
  const own = typeof option === 'object' ? option : {};
  const inherit = own.enabled === undefined || own.enabled === 'inherit';
  if (!(inherit ? a.tenancy().enabled : own.enabled)) return { enabled: false };
  const options: FilterOptions = {};
  if (own.kinds) options.kinds = own.kinds;
  if (own.family !== undefined) options.family = own.family;
  if (own.required !== undefined) options.required = own.required;
  const tenantFilter = a.tenantFilter.bind(a);
  return {
    enabled: true,
    nullRows: own.nullRows ?? 'tenantless',
    // Throws the context's TenantRequiredError (403) when a tenant is required and missing.
    filter: () => tenantFilter(Object.keys(options).length > 0 ? options : undefined),
  };
}

/** The matching rule: may this request see a row whose tenant column holds `rowTenantId`? */
export function canSeeRow(t: Tenancy, rowTenantId: string | null | undefined): boolean {
  if (!t.enabled) return true;
  const f = t.filter();
  if (f.mode === 'system' || f.mode === 'all') return true;
  if (rowTenantId === null || rowTenantId === undefined) {
    return f.mode === 'tenantless' || t.nullRows === 'shared';
  }
  return f.mode === 'tenant' && f.tenant.id === rowTenantId;
}

/** The tenant id to stamp on a new row: the active tenant's id, else `null`. */
export function rowTenantId(t: Tenancy): string | null {
  if (!t.enabled) return null;
  const f = t.filter();
  return f.mode === 'tenant' ? f.tenant.id : null;
}

/** Console labels keyed by tenant id: the app's `tenancy.label`, else the slug, else the id. */
export async function tenantLabels(
  tenants: TenantLevel[],
  accessor?: unknown,
): Promise<Record<string, string>> {
  const a = accessorOf(accessor);
  if (typeof a?.tenantLabels === 'function') {
    try {
      return await a.tenantLabels(tenants);
    } catch {
      // Fall back to slug/id below.
    }
  }
  const out: Record<string, string> = {};
  for (const t of tenants) out[t.id] = t.slug || t.id;
  return out;
}

// ── telescope's own additions (below the shared reader, which stays verbatim) ──────────────────

/** Telescope's `tenancy` option: the shared shape plus `tag`, the prefix of the tenant tag. */
export type TelescopeTenancyOption =
  | 'inherit'
  | false
  | {
      enabled?: 'inherit' | boolean;
      kinds?: string[];
      family?: string;
      required?: boolean;
      nullRows?: 'tenantless' | 'shared';
      /** Prefix of the tag entries get: `<tag>:<tenant id>`. Default `'tenant'`. */
      tag?: string;
    };

/** The tag prefix of a {@link TelescopeTenancyOption}. */
export function tenantTagPrefix(option: TelescopeTenancyOption | undefined): string {
  return typeof option === 'object' && option.tag ? option.tag : 'tenant';
}

/**
 * The same option with `required: false`: for the paths that are not a request reading data (the
 * recorder stamping entries, the pruner, the console's own-tenant lookup), which must never throw
 * the context's `TenantRequiredError`.
 */
export function lenientTenancy(option: TelescopeTenancyOption = 'inherit'): TelescopeTenancyOption {
  if (option === false) return false;
  return { ...(typeof option === 'object' ? option : {}), required: false };
}

/** The levels a tenant filter stands for, root first: its `chain` (context >= 2.1), else the tenant. */
export function tenantLevels(filter: TenantFilter): TenantLevel[] {
  if (filter.mode !== 'tenant') return [];
  const chain = filter.chain ?? filter.tenant.chain;
  return chain !== undefined && chain.length > 0 ? chain : [filter.tenant];
}
