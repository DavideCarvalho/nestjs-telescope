import { describe, expect, it } from 'vitest';
import { ExtensionRegistry } from './registry.js';
import type { ExtensionContext, TelescopeExtension } from './types.js';

const ctx = {
  moduleRef: {} as ExtensionContext['moduleRef'],
  config: {} as ExtensionContext['config'],
};

function ext(over: Partial<TelescopeExtension> & { name: string }): TelescopeExtension {
  return over;
}

describe('ExtensionRegistry', () => {
  it('merges watchers from all extensions in registration order', () => {
    const w1 = { type: 'a', register() {} };
    const w2 = { type: 'b', register() {} };
    const reg = new ExtensionRegistry(
      [ext({ name: 'one', watchers: () => [w1] }), ext({ name: 'two', watchers: () => [w2] })],
      ctx,
    );
    expect(reg.watchers().map((w) => w.type)).toEqual(['a', 'b']);
  });

  it('collects entry types and rejects duplicate ids across extensions', () => {
    const reg = () =>
      new ExtensionRegistry(
        [
          ext({ name: 'one', entryTypes: () => [{ id: 'dup', label: 'A', dot: 'bg-a' }] }),
          ext({ name: 'two', entryTypes: () => [{ id: 'dup', label: 'B', dot: 'bg-b' }] }),
        ],
        ctx,
      );
    expect(reg).toThrow(/entry type "dup".*"one".*"two"/);
  });

  it('rejects duplicate dashboard ids and duplicate provider names', () => {
    expect(
      () =>
        new ExtensionRegistry(
          [
            ext({ name: 'one', dashboards: () => [{ id: 'd', label: 'D', panels: [] }] }),
            ext({ name: 'two', dashboards: () => [{ id: 'd', label: 'D2', panels: [] }] }),
          ],
          ctx,
        ),
    ).toThrow(/dashboard "d".*"one".*"two"/);
    expect(
      () =>
        new ExtensionRegistry(
          [
            ext({ name: 'one', dataProviders: () => [{ name: 'p', resolve: async () => null }] }),
            ext({ name: 'two', dataProviders: () => [{ name: 'p', resolve: async () => null }] }),
          ],
          ctx,
        ),
    ).toThrow(/provider "p".*"one".*"two"/);
  });

  it('looks up a provider by name and exposes dashboards + entry types', () => {
    const reg = new ExtensionRegistry(
      [
        ext({
          name: 'one',
          entryTypes: () => [{ id: 'x', label: 'X', dot: 'bg-x' }],
          dashboards: () => [{ id: 'd', label: 'D', panels: [] }],
          dataProviders: () => [{ name: 'p', resolve: async () => ({ value: 1 }) }],
        }),
      ],
      ctx,
    );
    expect(reg.entryTypes()).toEqual([{ id: 'x', label: 'X', dot: 'bg-x' }]);
    expect(reg.dashboards().map((d) => d.id)).toEqual(['d']);
    expect(reg.findProvider('p')).toBeDefined();
    expect(reg.findProvider('missing')).toBeUndefined();
  });
});
