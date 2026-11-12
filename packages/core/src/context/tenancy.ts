// packages/core/src/context/tenancy.ts
//
// Local reader for the @dudousxd/nestjs-context tenancy contract. Copied into each lib;
// it imports nothing, so the lib works with any context version or none at all.
export interface TenantRef {
  id: string;
  kind: string;
  source: string;
  slug?: string;
  role?: string;
}
export type TenantFilter =
  | { mode: 'system' }
  | { mode: 'all' }
  | { mode: 'tenantless' }
  | { mode: 'tenant'; tenant: TenantRef };
export type TenancyOption =
  | 'inherit'
  | false
  | { enabled?: 'inherit' | boolean; kinds?: string[]; nullRows?: 'tenantless' | 'shared' };
export type Tenancy =
  | { enabled: false }
  | { enabled: true; nullRows: 'tenantless' | 'shared'; filter(): TenantFilter };

interface Accessor {
  tenancy?(): { enabled: boolean; kinds?: string[] };
  tenantFilter?(options?: { kinds?: string[] }): TenantFilter;
}
const SLOT = Symbol.for('@dudousxd/nestjs-diagnostics:accessor');

/** `accessor`: the `CONTEXT_ACCESSOR` injected with `@Optional()`, if any. Call per operation. */
export function readTenancy(option: TenancyOption = 'inherit', accessor?: unknown): Tenancy {
  const slot = (globalThis as unknown as Record<symbol, { current?: unknown } | undefined>)[SLOT];
  const a = (accessor ?? slot?.current) as Accessor | null | undefined;
  if (option === false || typeof a?.tenancy !== 'function' || !a.tenantFilter) {
    return { enabled: false };
  }
  const own = typeof option === 'object' ? option : {};
  const inherit = own.enabled === undefined || own.enabled === 'inherit';
  if (!(inherit ? a.tenancy().enabled : own.enabled)) return { enabled: false };
  const kinds = own.kinds;
  return {
    enabled: true,
    nullRows: own.nullRows ?? 'tenantless',
    filter: () => a.tenantFilter!(kinds ? { kinds } : undefined),
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

/** Telescope's `tenancy` option: the shared shape plus `tag`, the prefix of the tenant tag. */
export type TelescopeTenancyOption =
  | 'inherit'
  | false
  | {
      enabled?: 'inherit' | boolean;
      kinds?: string[];
      nullRows?: 'tenantless' | 'shared';
      /** Prefix of the tag entries get: `<tag>:<tenant id>`. Default `'tenant'`. */
      tag?: string;
    };

/** The tag prefix of a {@link TelescopeTenancyOption}. */
export function tenantTagPrefix(option: TelescopeTenancyOption | undefined): string {
  return typeof option === 'object' && option.tag ? option.tag : 'tenant';
}
