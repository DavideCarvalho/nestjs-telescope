import type { Watcher } from '../nest/watcher.js';
import type {
  DashboardSpec,
  DataProvider,
  ExtensionContext,
  ExtensionEntryType,
  TelescopeExtension,
} from './types.js';

/**
 * Resolves the registered extensions once at module init. Each multi-hook runs for
 * every extension and the results accumulate; an id/name claimed twice is a hard
 * error naming both owners (mirrors nestjs-codegen's `mergeExclusive`). Resolution is
 * eager so collisions fail at boot, not on first request.
 */
export class ExtensionRegistry {
  private readonly _watchers: Watcher[] = [];
  private readonly _entryTypes: ExtensionEntryType[] = [];
  private readonly _dashboards: DashboardSpec[] = [];
  private readonly _providers = new Map<string, DataProvider>();
  /** Provider name → the `name` of the extension that contributed it. */
  private readonly _providerOwners = new Map<string, string>();

  constructor(extensions: readonly TelescopeExtension[], ctx: ExtensionContext) {
    const entryOwners = new Map<string, string>();
    const dashOwners = new Map<string, string>();
    const provOwners = this._providerOwners;

    for (const ext of extensions) {
      for (const w of ext.watchers?.(ctx) ?? []) this._watchers.push(w);

      for (const et of ext.entryTypes?.(ctx) ?? []) {
        const prev = entryOwners.get(et.id);
        if (prev !== undefined) {
          throw new Error(
            `Telescope entry type "${et.id}" is contributed by both "${prev}" and "${ext.name}". Entry-type ids must be unique.`,
          );
        }
        entryOwners.set(et.id, ext.name);
        this._entryTypes.push(et);
      }

      for (const d of ext.dashboards?.(ctx) ?? []) {
        const prev = dashOwners.get(d.id);
        if (prev !== undefined) {
          throw new Error(
            `Telescope dashboard "${d.id}" is contributed by both "${prev}" and "${ext.name}". Dashboard ids must be unique.`,
          );
        }
        dashOwners.set(d.id, ext.name);
        this._dashboards.push(d);
      }

      for (const p of ext.dataProviders?.(ctx) ?? []) {
        const prev = provOwners.get(p.name);
        if (prev !== undefined) {
          throw new Error(
            `Telescope data provider "${p.name}" is contributed by both "${prev}" and "${ext.name}". Provider names must be unique.`,
          );
        }
        provOwners.set(p.name, ext.name);
        this._providers.set(p.name, p);
      }
    }
  }

  watchers(): Watcher[] {
    return [...this._watchers];
  }
  entryTypes(): ExtensionEntryType[] {
    return [...this._entryTypes];
  }
  dashboards(): DashboardSpec[] {
    return [...this._dashboards];
  }
  findProvider(name: string): DataProvider | undefined {
    return this._providers.get(name);
  }
  /** The `name` of the extension that contributed the given provider, or undefined. */
  providerOwner(name: string): string | undefined {
    return this._providerOwners.get(name);
  }
}
