import { describe, expect, it } from 'vitest';
import type { Tenancy, TenantFilter } from '../context/tenancy.js';
import { normalizeConsoleResult } from './console-authorize.js';
import {
  consoleTenantsOf,
  resolveConsoleTenantScope,
  selectConsoleTenant,
} from './console-tenant-scope.js';

const on = (filter: TenantFilter): Tenancy => ({
  enabled: true,
  nullRows: 'tenantless',
  filter: () => filter,
});
const own: TenantFilter = {
  mode: 'tenant',
  tenant: { id: 'A', kind: 'organization', source: 'app', slug: 'acme' },
};

describe('console tenant scope', () => {
  it('keeps `tenants` through normalizeConsoleResult, and only valid ones', () => {
    expect(normalizeConsoleResult({ allowed: true })).toEqual({ allowed: true });
    expect(normalizeConsoleResult({ allowed: true, tenants: '*' })).toEqual({
      allowed: true,
      tenants: '*',
    });
    expect(normalizeConsoleResult({ allowed: true, tenants: ['A', '', 'A', 3] })).toEqual({
      allowed: true,
      tenants: ['A'],
    });
    expect(consoleTenantsOf({ allowed: true, tenants: 'A' })).toBeUndefined();
  });

  it('tenancy off: no scope, every call sees everything', () => {
    const scope = resolveConsoleTenantScope({ enabled: false }, ['A']);
    expect(scope).toBeNull();
    expect(selectConsoleTenant(scope, 'B')).toEqual({ kind: 'all' });
  });

  it('no `tenants`: the own tenant, or none', () => {
    expect(resolveConsoleTenantScope(on(own), undefined)).toEqual({
      tenants: ['A'],
      own: { id: 'A', slug: 'acme' },
    });
    const none = resolveConsoleTenantScope(on({ mode: 'tenantless' }), undefined);
    expect(none).toEqual({ tenants: [] });
    expect(selectConsoleTenant(none, undefined)).toEqual({ kind: 'none' });
  });

  it('a list: own tenant first, else the first; outside it is forged', () => {
    const scope = resolveConsoleTenantScope(on(own), ['B', 'A']);
    expect(selectConsoleTenant(scope, undefined)).toEqual({ kind: 'tenant', id: 'A' });
    expect(
      selectConsoleTenant(resolveConsoleTenantScope(on({ mode: 'tenantless' }), ['B', 'A']), ''),
    ).toEqual({
      kind: 'tenant',
      id: 'B',
    });
    expect(selectConsoleTenant(scope, 'C')).toEqual({ kind: 'none', forged: 'C' });
  });

  it("'*': all without ?tenant=, else that tenant", () => {
    const scope = resolveConsoleTenantScope(on(own), '*');
    expect(selectConsoleTenant(scope, undefined)).toEqual({ kind: 'all' });
    expect(selectConsoleTenant(scope, 'Z')).toEqual({ kind: 'tenant', id: 'Z' });
    expect(selectConsoleTenant(scope, '*')).toEqual({ kind: 'all' });
  });

  it("a list naming '*' grants every organization", () => {
    expect(consoleTenantsOf({ allowed: true, tenants: ['*'] })).toBe('*');
    expect(consoleTenantsOf({ allowed: true, tenants: ['A', '*'] })).toBe('*');
  });
});
