// packages/core/src/nest/console-view.ts
//
// The one place that turns what `authorize` granted (organizations and apps) and what a call asked
// for (`?tenant=`, `?app=`) into the view every read of the call goes through.
import { readTenancy, tenantTagPrefix } from '../context/tenancy.js';
import { type TenantView, intersectViews, tenantViewOf } from '../storage/tenant-scoped-storage.js';
import {
  type ConsoleAppSelection,
  type ConsoleApps,
  appViewOf,
  selectConsoleApp,
} from './console-app-scope.js';
import {
  type ConsoleTenantScope,
  type ConsoleTenantSelection,
  type ConsoleTenants,
  resolveConsoleTenantScope,
  selectConsoleTenant,
} from './console-tenant-scope.js';
import type { TelescopeModuleOptions } from './telescope.options.js';

/** The organization part of a call (`undefined` with tenancy off). */
export interface ConsoleTenantCall {
  scope: ConsoleTenantScope | null;
  selection: ConsoleTenantSelection;
}

/** The app part of a call. */
export interface ConsoleAppCall {
  apps: ConsoleApps | undefined;
  selection: ConsoleAppSelection;
}

export interface ConsoleViewCall {
  tenant: ConsoleTenantCall | undefined;
  app: ConsoleAppCall;
  /** What the call reads: `null` for everything. */
  view: TenantView | null;
}

export interface ConsoleViewInput {
  options: Pick<TelescopeModuleOptions, 'tenancy'> | undefined;
  accessor: unknown;
  granted: { tenants?: ConsoleTenants | undefined; apps?: ConsoleApps | undefined };
  requested?: { tenant?: string | undefined; app?: string | undefined };
}

/**
 * The view of a console call. Throws what the organization scope throws (the context's
 * `TenantRequiredError` when a required tenancy has no tenant and `authorize` granted none).
 */
export function resolveConsoleView(input: ConsoleViewInput): ConsoleViewCall {
  const tenancy = readTenancy(input.options?.tenancy, input.accessor);
  let tenant: ConsoleTenantCall | undefined;
  let tenantView: TenantView | null = null;
  if (tenancy.enabled) {
    const scope = resolveConsoleTenantScope(tenancy, input.granted.tenants);
    const selection = selectConsoleTenant(scope, input.requested?.tenant);
    tenant = { scope, selection };
    tenantView = tenantViewOf(selection, tenantTagPrefix(input.options?.tenancy), tenancy.nullRows);
  }
  const appSelection = selectConsoleApp(input.granted.apps, input.requested?.app);
  return {
    tenant,
    app: { apps: input.granted.apps, selection: appSelection },
    view: intersectViews(tenantView, appViewOf(appSelection)),
  };
}
