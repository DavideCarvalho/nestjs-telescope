// packages/core/src/nest/console-search.ts
import type { ExecutionContext } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { CONTEXT_ACCESSOR } from '../context/context-accessor.js';
import { readTenancy, tenantTagPrefix } from '../context/tenancy.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { type TenantView, tenantViewOf, withTenantView } from '../storage/tenant-scoped-storage.js';
import type { ConsoleDecide } from './console-authorize.js';
import type { AviaryConsoleSearchHit } from './console-switcher.js';
import { resolveConsoleTenantScope, selectConsoleTenant } from './console-tenant-scope.js';
import { summarizeEntry } from './telescope-tools.js';
import {
  TELESCOPE_OPTIONS,
  TELESCOPE_STORAGE,
  type TelescopeModuleOptions,
} from './telescope.options.js';

function optional<T>(moduleRef: ModuleRef, token: symbol): T | undefined {
  try {
    return moduleRef.get<T>(token, { strict: false }) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Shortens a summary for a hit's subtitle. */
function clip(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The telescope console's global search (the switcher's `search`): an exact entry id opens that
 * entry, and tags containing the query open the entries list filtered by the tag. With
 * organizations on it reads the viewer's view, as the console would show it: the organizations its
 * `authorize` grants, and nothing when it denies.
 */
export function telescopeConsoleSearch(
  moduleRef: ModuleRef,
  decide: ConsoleDecide,
  path: string,
): (context: ExecutionContext, q: string, limit: number) => Promise<AviaryConsoleSearchHit[]> {
  const base = `/${path.replace(/^\/+|\/+$/g, '')}`;
  return async (context, q, limit) => {
    const storage = optional<StorageProvider>(moduleRef, TELESCOPE_STORAGE);
    if (storage === undefined || q === '' || limit <= 0) return [];
    const options = optional<TelescopeModuleOptions>(moduleRef, TELESCOPE_OPTIONS);
    const tenancy = readTenancy(options?.tenancy, optional(moduleRef, CONTEXT_ACCESSOR));
    let view: TenantView | null = null;
    if (tenancy.enabled) {
      const decision = await decide(context);
      if (!decision.allowed) return [];
      const scope = resolveConsoleTenantScope(tenancy, decision.tenants);
      view = tenantViewOf(
        selectConsoleTenant(scope, undefined),
        tenantTagPrefix(options?.tenancy),
        tenancy.nullRows,
      );
    }
    return withTenantView(view, async () => {
      const hits: AviaryConsoleSearchHit[] = [];
      const found = await storage.find(q).catch(() => null);
      if (found !== null) {
        hits.push({
          title: `${found.type} ${found.id}`,
          subtitle: clip(summarizeEntry(found)),
          href: `${base}#/entries/view/${encodeURIComponent(found.id)}`,
        });
      }
      if (hits.length < limit) {
        // A failing tag listing keeps the id hit.
        const tags = await storage
          .tags(undefined, { search: q, limit: limit - hits.length })
          .catch(() => []);
        for (const { tag, count } of tags) {
          hits.push({
            title: tag,
            subtitle: `${count} ${count === 1 ? 'entry' : 'entries'} tagged`,
            href: `${base}#/entries?tag=${encodeURIComponent(tag)}`,
          });
        }
      }
      return hits.slice(0, limit);
    });
  };
}
