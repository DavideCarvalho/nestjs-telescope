// packages/core/src/nest/console-tenant.interceptor.ts
//
// Runs each console call inside the tenant view its viewer may see (tenancy on), so every read of
// the store made by the call is scoped. Tenancy off: the call runs untouched.
import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Observable } from 'rxjs';
import { CONTEXT_ACCESSOR } from '../context/context-accessor.js';
import { openFederationScope } from '../federation/scope.js';
import { type TenantView, openTenantView } from '../storage/tenant-scoped-storage.js';
import { type ConsoleAppSelection, consoleAppsFor, requestedApp } from './console-app-scope.js';
import { type ConsoleTenantSelection, consoleTenantsFor } from './console-tenant-scope.js';
import {
  type ConsoleAppCall,
  type ConsoleTenantCall,
  type ConsoleViewCall,
  resolveConsoleView,
} from './console-view.js';
import { TELESCOPE_OPTIONS, type TelescopeModuleOptions } from './telescope.options.js';

const logger = new Logger('TelescopeModule');

/** The `?tenant=` of a request (Express and Fastify both parse `query`). */
export function requestedTenant(request: unknown): string | undefined {
  const query = (request as { query?: Record<string, unknown> } | undefined)?.query;
  const value = query?.tenant;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Logs a `?tenant=` outside the viewer's scope: the call answers empty. */
export function logForgedTenant(selection: ConsoleTenantSelection, where: string): void {
  if (selection.kind === 'none' && selection.forged !== undefined) {
    logger.warn(
      `${where}: tenant "${selection.forged}" is outside the viewer's scope; answering with no data.`,
    );
  }
}

/** Logs an `?app=` outside the viewer's apps: the call answers empty. */
export function logForgedApp(selection: ConsoleAppSelection, where: string): void {
  if (selection.kind === 'none' && selection.forged !== undefined) {
    logger.warn(
      `${where}: app "${selection.forged}" is outside the viewer's apps; answering with no data.`,
    );
  }
}

export type { ConsoleAppCall, ConsoleTenantCall };

const calls = new WeakMap<object, ConsoleViewCall>();

/** The organization scope and selection of this console request (tenancy off or not seen: `undefined`). */
export function consoleTenantCallOf(request: unknown): ConsoleTenantCall | undefined {
  return typeof request === 'object' && request !== null ? calls.get(request)?.tenant : undefined;
}

/**
 * The organization view of this console request alone, without its app part (`null`: every
 * organization; not seen: `undefined`). A trace's waterfall reads across apps inside it.
 */
export function consoleTenantViewOf(request: unknown): TenantView | null | undefined {
  return typeof request === 'object' && request !== null
    ? calls.get(request)?.tenantView
    : undefined;
}

/** The app grant and selection of this console request (not seen: `undefined`). */
export function consoleAppCallOf(request: unknown): ConsoleAppCall | undefined {
  return typeof request === 'object' && request !== null ? calls.get(request)?.app : undefined;
}

/**
 * Runs each console call inside the view its viewer may see: the organizations (tenancy on) and
 * the apps (`?app=`, within what `authorize` granted) it shows. With neither, the call runs untouched.
 */
@Injectable()
export class ConsoleTenantInterceptor implements NestInterceptor {
  constructor(@Inject(ModuleRef) private readonly moduleRef: ModuleRef) {}

  private optional(token: symbol): unknown {
    try {
      return this.moduleRef.get(token, { strict: false });
    } catch {
      return undefined;
    }
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const options = this.optional(TELESCOPE_OPTIONS) as TelescopeModuleOptions | undefined;
    const request = context.switchToHttp().getRequest<object>();
    const call = resolveConsoleView({
      options,
      accessor: this.optional(CONTEXT_ACCESSOR),
      granted: { tenants: consoleTenantsFor(request), apps: consoleAppsFor(request) },
      requested: { tenant: requestedTenant(request), app: requestedApp(request) },
    });
    calls.set(request, call);
    const where = `${context.getClass().name}.${context.getHandler().name}`;
    if (call.tenant) logForgedTenant(call.tenant.selection, where);
    logForgedApp(call.app.selection, where);
    const view = call.view;
    const federation = call.federation;
    if (view === null && federation === undefined) return next.handle();
    return new Observable((subscriber) => {
      // `federation`: the stores the call reads, opened around the view.
      const scope = federation !== undefined ? openFederationScope(federation) : null;
      const handle = view !== null ? openTenantView(view) : null;
      const subscribe = () => next.handle().subscribe(subscriber);
      const inView = () => (handle !== null ? handle.run(subscribe) : subscribe());
      const subscription = scope !== null ? scope.run(inView) : inView();
      return () => {
        handle?.close();
        scope?.close();
        subscription.unsubscribe();
      };
    });
  }
}
