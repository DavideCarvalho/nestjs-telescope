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
import { readTenancy, tenantTagPrefix } from '../context/tenancy.js';
import { openTenantView, tenantViewOf } from '../storage/tenant-scoped-storage.js';
import {
  type ConsoleTenantScope,
  type ConsoleTenantSelection,
  consoleTenantsFor,
  resolveConsoleTenantScope,
  selectConsoleTenant,
} from './console-tenant-scope.js';
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

/** A console call's scope and selection, as the interceptor resolved them. */
export interface ConsoleTenantCall {
  scope: ConsoleTenantScope | null;
  selection: ConsoleTenantSelection;
}

const calls = new WeakMap<object, ConsoleTenantCall>();

/** The scope and selection of this console request (tenancy off or not seen: `undefined`). */
export function consoleTenantCallOf(request: unknown): ConsoleTenantCall | undefined {
  return typeof request === 'object' && request !== null ? calls.get(request) : undefined;
}

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
    const tenancy = readTenancy(options?.tenancy, this.optional(CONTEXT_ACCESSOR));
    if (!tenancy.enabled) return next.handle();
    const request = context.switchToHttp().getRequest<object>();
    const scope = resolveConsoleTenantScope(tenancy, consoleTenantsFor(request));
    const selection = selectConsoleTenant(scope, requestedTenant(request));
    calls.set(request, { scope, selection });
    logForgedTenant(selection, `${context.getClass().name}.${context.getHandler().name}`);
    const view = tenantViewOf(selection, tenantTagPrefix(options?.tenancy), tenancy.nullRows);
    if (view === null) return next.handle();
    return new Observable((subscriber) => {
      const handle = openTenantView(view);
      const subscription = handle.run(() => next.handle().subscribe(subscriber));
      return () => {
        handle.close();
        subscription.unsubscribe();
      };
    });
  }
}
