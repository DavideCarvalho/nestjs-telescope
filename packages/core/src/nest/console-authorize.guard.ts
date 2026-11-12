// packages/core/src/nest/console-authorize.guard.ts
//
// Enforcement of the console `authorize`: a guard (decides) and a filter scoped
// to the console controllers (answers).
import 'reflect-metadata';
import {
  type ArgumentsHost,
  type CanActivate,
  Catch,
  type ExceptionFilter,
  type ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  type InjectionToken,
  Logger,
  type OnModuleInit,
  type Type,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { HttpAdapterHost, ModuleRef } from '@nestjs/core';
import {
  CONSOLE_AUTHORIZE_MISSING_WARNING,
  type ConsoleAuthorize,
  type ConsoleDecide,
  type ConsoleDecision,
  resolveConsoleAuthorize,
} from './console-authorize.js';
import { rememberConsoleTenants } from './console-tenant-scope.js';
import { ConsoleTenantInterceptor } from './console-tenant.interceptor.js';
import { TELESCOPE_OPTIONS } from './telescope.options.js';

/** Options of {@link UseConsoleAuthorize} and {@link ConsoleAuthorizeGuard.for}. */
export interface UseConsoleAuthorizeOptions {
  /**
   * Who may use the routes. Omitted: `TelescopeModule`'s `authorize`; with
   * none there either, open outside production and 403 in production.
   */
  authorize?: ConsoleAuthorize | undefined;
}

/**
 * @internal What the library's own modules pass: where to read `authorize`
 * from once the module's options are resolved, and the boot warning.
 */
export interface ConsoleAuthorizeGuardConfig extends UseConsoleAuthorizeOptions {
  /** Read `authorize` from this provider at init (async options). Wins over the `TelescopeModule` fallback. */
  from?: { token: InjectionToken; select: (options: unknown) => ConsoleAuthorize | undefined };
  /** Fall back to `TelescopeModule`'s `authorize` when none is given. Default `true`. */
  inherit?: boolean;
  /**
   * Log the "no `authorize`" boot warning when it is omitted. Default: only
   * when no module stands behind the guard (the modules warn themselves).
   */
  warn?: boolean;
  /** The warning's text. Default {@link CONSOLE_AUTHORIZE_MISSING_WARNING}. */
  missingWarning?: string;
  /** The logger context of the warnings. Default `TelescopeModule`. */
  loggerContext?: string;
}

/** Marks a controller as serving pages: a denied `GET` that accepts HTML gets a page, not JSON. */
export const CONSOLE_PAGE_METADATA = '@dudousxd/nestjs-telescope:console-page';
export const ConsolePage = (): ClassDecorator => (target) => {
  Reflect.defineMetadata(CONSOLE_PAGE_METADATA, true, target);
};

/**
 * The denial the guard throws. An `HttpException` with the JSON body, so it still answers correctly
 * where {@link ConsoleAuthorizeFilter} is not applied; the filter adds the page answers.
 */
export class ConsoleAccessDenied extends HttpException {
  constructor(
    readonly decision: Extract<ConsoleDecision, { allowed: false }>,
    readonly page: boolean,
  ) {
    const unauthenticated = decision.reason === 'unauthenticated';
    super(
      unauthenticated
        ? {
            error: 'unauthenticated',
            ...(decision.redirectTo !== undefined ? { redirectTo: decision.redirectTo } : {}),
          }
        : { error: 'forbidden' },
      unauthenticated ? 401 : 403,
    );
  }
}

function deniedPage(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0"><main style="text-align:center"><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

const ACCESS_DENIED_PAGE = deniedPage('Access denied', 'You do not have access to this console.');
const SIGN_IN_REQUIRED_PAGE = deniedPage('Sign in required', 'Sign in to open this console.');

/** Writes console denials: JSON for API calls; a 302 or an HTML page for page navigations. */
@Catch(ConsoleAccessDenied)
export class ConsoleAuthorizeFilter implements ExceptionFilter {
  constructor(@Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: ConsoleAccessDenied, host: ArgumentsHost): void {
    const adapter = this.adapterHost.httpAdapter;
    const response = host.switchToHttp().getResponse();
    const { decision, page } = exception;
    if (page && decision.redirectTo !== undefined) {
      adapter.redirect(response, 302, decision.redirectTo);
      return;
    }
    if (page) {
      const forbidden = decision.reason === 'forbidden';
      adapter.setHeader(response, 'Content-Type', 'text/html; charset=utf-8');
      adapter.reply(
        response,
        forbidden ? ACCESS_DENIED_PAGE : SIGN_IN_REQUIRED_PAGE,
        forbidden ? 403 : 401,
      );
      return;
    }
    adapter.reply(response, exception.getResponse(), exception.getStatus());
  }
}

function isPageNavigation(context: ExecutionContext): boolean {
  if (context.getType() !== 'http') return false;
  if (Reflect.getMetadata(CONSOLE_PAGE_METADATA, context.getClass()) !== true) return false;
  const request = context
    .switchToHttp()
    .getRequest<{ method?: string; headers?: Record<string, unknown> }>();
  const accept = request?.headers?.accept;
  return request?.method === 'GET' && typeof accept === 'string' && accept.includes('text/html');
}

/**
 * The console's access guard: runs the resolved `authorize` for every request
 * and turns a denial into a 401/403 (or a 302 / HTML page for a page
 * navigation, through {@link ConsoleAuthorizeFilter}). Apply it after the
 * app's authentication so `request.user` is set; the library's own modules do.
 *
 * As is, it runs `TelescopeModule`'s `authorize`. {@link ConsoleAuthorizeGuard.for}
 * builds one with its own `authorize`; {@link UseConsoleAuthorize} applies
 * either together with the filter.
 */
@Injectable()
export class ConsoleAuthorizeGuard implements CanActivate, OnModuleInit {
  /** A guard class with its own `authorize`, for `@UseGuards(...)`. */
  static for(options: ConsoleAuthorizeGuardConfig = {}): Type<CanActivate> {
    @Injectable()
    class ConsoleAuthorizeGuardForRegistration extends ConsoleAuthorizeGuard {
      protected override readonly config = options;
    }
    return ConsoleAuthorizeGuardForRegistration;
  }

  /** This registration's options; none: `TelescopeModule`'s `authorize`. */
  protected readonly config: ConsoleAuthorizeGuardConfig = {};
  private decide?: Promise<ConsoleDecide>;

  constructor(@Inject(ModuleRef) private readonly moduleRef: ModuleRef) {}

  async onModuleInit(): Promise<void> {
    await this.init();
  }

  private optional(token: InjectionToken): unknown {
    try {
      return this.moduleRef.get(token, { strict: false });
    } catch {
      return undefined;
    }
  }

  private init(): Promise<ConsoleDecide> {
    this.decide ??= (async () => {
      const config = this.config;
      let authorize = config.authorize;
      let moduleBacked = config.from !== undefined;
      if (authorize === undefined && config.from) {
        authorize = config.from.select(this.optional(config.from.token));
      }
      if (authorize === undefined && !config.from && config.inherit !== false) {
        const core = this.optional(TELESCOPE_OPTIONS) as
          | { authorize?: ConsoleAuthorize }
          | undefined;
        if (core) {
          moduleBacked = true;
          authorize = core.authorize;
        }
      }
      return resolveConsoleAuthorize(authorize, this.moduleRef, {
        logger: new Logger(config.loggerContext ?? 'TelescopeModule'),
        warnIfMissing: config.warn ?? !moduleBacked,
        missingWarning: config.missingWarning ?? CONSOLE_AUTHORIZE_MISSING_WARNING,
      });
    })();
    return this.decide;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const decision = await (await this.init())(context);
    if (decision.allowed) {
      if (context.getType() === 'http') {
        rememberConsoleTenants(context.switchToHttp().getRequest(), decision.tenants);
      }
      return true;
    }
    throw new ConsoleAccessDenied(decision, isPageNavigation(context));
  }
}

/**
 * The guard, its filter and the tenant scope (with tenancy on, each call sees
 * the organizations `authorize` granted) as one class decorator, for a console
 * controller you mount yourself (`routes: false`). With no `authorize` it runs
 * `TelescopeModule`'s. List it ABOVE your authentication guards: Nest applies
 * class decorators bottom-up, so your authentication runs first.
 *
 * ```ts
 * @Controller('ops/telescope/api')
 * @UseConsoleAuthorize()
 * @UseGuards(AuthGuard)
 * class ConsoleApi extends TelescopeController {}
 * ```
 */
export function UseConsoleAuthorize(options?: ConsoleAuthorizeGuardConfig): ClassDecorator {
  const guard =
    options === undefined || Object.keys(options).length === 0
      ? ConsoleAuthorizeGuard
      : ConsoleAuthorizeGuard.for(options);
  return (target) => {
    UseGuards(guard)(target);
    UseFilters(ConsoleAuthorizeFilter)(target);
    UseInterceptors(ConsoleTenantInterceptor)(target);
  };
}
