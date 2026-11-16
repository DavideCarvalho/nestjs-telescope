import { describe, expect, it } from 'vitest';
import { appViewOf, consoleAppsOf, selectConsoleApp } from '../nest/console-app-scope.js';
import { isRollupStore } from '../rollup/rollup-store.js';
import { InMemoryStorageProvider } from './in-memory-storage-provider.js';
import {
  asTenantScopedStorage,
  intersectViews,
  tenantViewOf,
  withTenantView,
} from './tenant-scoped-storage.js';

const tagged = (...tags: string[]) => ({ tags });

describe('app scope', () => {
  it('reads apps from an authorize result', () => {
    expect(consoleAppsOf({ allowed: true })).toBeUndefined();
    expect(consoleAppsOf({ allowed: true, apps: '*' })).toBe('*');
    expect(consoleAppsOf({ allowed: true, apps: ['a', '*'] })).toBe('*');
    expect(consoleAppsOf({ allowed: true, apps: ['a', '', 3, 'a'] })).toEqual(['a']);
  });

  it('meets ?app= with the grant', () => {
    expect(selectConsoleApp(undefined, undefined)).toEqual({ kind: 'all' });
    expect(selectConsoleApp('*', '*')).toEqual({ kind: 'all' });
    expect(selectConsoleApp('*', 'shop')).toEqual({ kind: 'apps', ids: ['shop'] });
    expect(selectConsoleApp(['shop', 'bill'], undefined)).toEqual({
      kind: 'apps',
      ids: ['shop', 'bill'],
    });
    expect(selectConsoleApp(['shop'], 'bill')).toEqual({ kind: 'none', forged: 'bill' });
    expect(selectConsoleApp([], undefined)).toEqual({ kind: 'none' });
  });

  it('intersects an organization view with an app view', () => {
    const view = intersectViews(
      tenantViewOf({ kind: 'tenant', id: 'A' }, 'tenant', 'tenantless'),
      appViewOf({ kind: 'apps', ids: ['shop', 'bill'] }),
    );
    expect(view?.tag).toBe('tenant:A');
    expect(view?.accept(tagged('tenant:A', 'app:shop'))).toBe(true);
    expect(view?.accept(tagged('tenant:A', 'app:other'))).toBe(false);
    expect(view?.accept(tagged('tenant:B', 'app:shop'))).toBe(false);
    expect(view?.accept(tagged('tenant:A'))).toBe(false);
    expect(intersectViews(null, null)).toBeNull();
    expect(intersectViews(appViewOf({ kind: 'none' }), null)?.empty).toBe(true);
  });

  it('hides unscoped rollups inside a view, so metrics scan the view instead', async () => {
    const store = asTenantScopedStorage(new InMemoryStorageProvider());
    expect(isRollupStore(store)).toBe(true);
    await withTenantView(appViewOf({ kind: 'apps', ids: ['shop'] }), async () => {
      expect(isRollupStore(store)).toBe(false);
    });
    expect(isRollupStore(store)).toBe(true);
  });
});
