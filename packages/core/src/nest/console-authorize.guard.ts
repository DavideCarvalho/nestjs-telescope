// packages/core/src/nest/console-authorize.guard.ts
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
} from '@nestjs/common';
import { HttpAdapterHost, ModuleRef } from '@nestjs/core';
import {
  type ConsoleAuthorize,
  type ConsoleDecision,
  resolveConsoleAuthorize,
} from './console-authorize.js';

/** Options of {@link ConsoleAuthorizeGuard.for} and {@link UseConsoleAuthorize}. */
export interface ConsoleAuthorizeGuardOptions {
  /** Who may use the routes. Omitted: open outside production, 403 in production. */
  authorize?: ConsoleAuthorize | undefined;
  /**
   * The routes serve pages: a browser navigation (`GET` with `Accept: text/html`)
   * that is denied gets a 302 to `redirectTo` or an "Access denied" page
   * instead of JSON. Default `false`.
   */
  pages?: boolean;
}

/**
 * @internal What the library's own modules pass: where to read `authorize`
 * from once the module's options are resolved, and how to name the module in
 * the boot warning.
 */
export interface ConsoleAuthorizeGuardConfig extends ConsoleAuthorizeGuardOptions {
  /** Read `authorize` from this provider at init (async options). Wins over `authorize` when set. */
  from?: { token: InjectionToken; select: (options: unknown) => ConsoleAuthorize | undefined };
  /** Log the "no `authorize`" boot warning when it is omitted. Default `true`. */
  warn?: boolean;
  /** Package named in the warning. Default `@dudousxd/nestjs-telescope`. */
  packageName?: string;
  /** Module named in the warning (and its logger context). Default `TelescopeModule`. */
  moduleName?: string;
  /** How the module is registered, for the warning. Default `<moduleName>.forRoot()`. */
  registration?: string;
}

/**
 * A console denial: carries the JSON body and status; {@link ConsoleDeniedFilter}
 * turns page navigations into a redirect or an HTML page. Without the filter
 * Nest still answers the status with the JSON body.
 */
export class ConsoleDeniedException extends HttpException {
  constructor(
    readonly decision: Exclude<ConsoleDecision, { allowed: true }>,
    readonly page: boolean,
  ) {
    super(
      decision.reason === 'forbidden'
        ? { error: 'forbidden' }
        : decision.redirectTo !== undefined
          ? { error: 'unauthenticated', redirectTo: decision.redirectTo }
          : { error: 'unauthenticated' },
      decision.reason === 'forbidden' ? 403 : 401,
    );
  }
}

const ACCESS_DENIED_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Access denied</title></head><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0"><main style="text-align:center"><h1>Access denied</h1><p>You are not allowed to open this console.</p></main></body></html>';

/** Writes console denials: JSON for API calls, 302 or an HTML page for page navigations. */
@Catch(ConsoleDeniedException)
export class ConsoleDeniedFilter implements ExceptionFilter {
  constructor(@Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: ConsoleDeniedException, host: ArgumentsHost): void {
    const adapter = this.adapterHost.httpAdapter;
    const response = host.switchToHttp().getResponse();
    const { decision, page } = exception;
    if (page && decision.redirectTo !== undefined) {
      adapter.redirect(response, 302, decision.redirectTo);
      return;
    }
    if (page && decision.reason === 'forbidden') {
      adapter.setHeader(response, 'Content-Type', 'text/html; charset=utf-8');
      adapter.reply(response, ACCESS_DENIED_PAGE, 403);
      return;
    }
    adapter.reply(response, exception.getResponse(), exception.getStatus());
  }
}

function isPageNavigation(context: ExecutionContext): boolean {
  const request = context
    .switchToHttp()
    .getRequest<{ method?: string; headers?: Record<string, unknown> }>();
  if (request?.method !== 'GET') return false;
  const accept = request.headers?.accept;
  return typeof accept === 'string' && accept.includes('text/html');
}

function noAuthorizeWarning(config: ConsoleAuthorizeGuardConfig): string {
  const packageName = config.packageName ?? '@dudousxd/nestjs-telescope';
  const registration = config.registration ?? `${config.moduleName ?? 'TelescopeModule'}.forRoot()`;
  return `[${packageName}] console has no \`authorize\` configured: it is open outside production and denies every request in production. Set \`authorize\` in ${registration}.`;
}

/**
 * The console's access guard: runs the resolved `authorize` for every request
 * and turns a denial into a 401/403 (or a 302 for a page). Apply it after the
 * app's authentication so `request.user` is set; the library's own modules do.
 *
 * With `authorize` omitted the routes are open outside production and answer
 * 403 in production, and one warning is logged at boot.
 *
 * Build one per registration with {@link ConsoleAuthorizeGuard.for}, or use
 * {@link UseConsoleAuthorize} on a controller you mount yourself.
 */
export abstract class ConsoleAuthorizeGuard implements CanActivate, OnModuleInit {
  /**
   * A guard class for one registration. Mount it with `@UseGuards(...)`
   * together with `@UseFilters(ConsoleDeniedFilter)` (what
   * {@link UseConsoleAuthorize} does in one decorator).
   */
  static for(options: ConsoleAuthorizeGuardConfig = {}): Type<CanActivate> {
    @Injectable()
    class ConsoleAuthorizeGuardForRegistration extends ConsoleAuthorizeGuard {
      constructor(@Inject(ModuleRef) moduleRef: ModuleRef) {
        super(moduleRef, options);
      }
    }
    return ConsoleAuthorizeGuardForRegistration;
  }

  private check?: (context: ExecutionContext) => Promise<ConsoleDecision>;
  private initialized?: Promise<void>;

  protected constructor(
    private readonly moduleRef: ModuleRef,
    private readonly config: ConsoleAuthorizeGuardConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.init();
  }

  private init(): Promise<void> {
    this.initialized ??= (async () => {
      let authorize = this.config.authorize;
      if (this.config.from) {
        const options = this.moduleRef.get(this.config.from.token, { strict: false });
        authorize = this.config.from.select(options) ?? authorize;
      }
      if (authorize === undefined) {
        if (this.config.warn !== false) {
          new Logger(this.config.moduleName ?? 'TelescopeModule').warn(
            noAuthorizeWarning(this.config),
          );
        }
        this.check = async () =>
          process.env.NODE_ENV === 'production'
            ? { allowed: false, reason: 'forbidden' }
            : { allowed: true };
        return;
      }
      const resolved = resolveConsoleAuthorize(authorize, this.moduleRef);
      await resolved.ready;
      this.check = resolved;
    })();
    return this.initialized;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await this.init();
    const decision = (await this.check?.(context)) ?? {
      allowed: false as const,
      reason: 'forbidden' as const,
    };
    if (decision.allowed) return true;
    throw new ConsoleDeniedException(
      decision,
      this.config.pages === true && isPageNavigation(context),
    );
  }
}

/**
 * Protects a controller you mount yourself (`routes: false`) with the same
 * `authorize` contract as the mounted console: applies the guard and the
 * filter that writes its denials.
 *
 * ```ts
 * @Controller('ops/telescope/api')
 * @UseConsoleAuthorize({ authorize: (ctx) => ctx.switchToHttp().getRequest().user?.isAdmin === true })
 * class ConsoleApi extends TelescopeController {}
 * ```
 */
export function UseConsoleAuthorize(options: ConsoleAuthorizeGuardConfig = {}): ClassDecorator {
  const guard = ConsoleAuthorizeGuard.for(options);
  return (target) => {
    UseGuards(guard)(target);
    UseFilters(ConsoleDeniedFilter)(target);
  };
}
