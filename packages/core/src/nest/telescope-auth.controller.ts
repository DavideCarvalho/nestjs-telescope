// packages/core/src/nest/telescope-auth.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { readCookieHeader } from '../auth/auth-request.js';
import { parseCookieHeader } from '../auth/cookie-header.js';
import type { ResolvedDashboardAuth } from '../auth/dashboard-auth-config.js';
import {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  issueSessionCookie,
} from '../auth/session-cookie-io.js';
import { type TelescopeSessionUser, verifySessionCookie } from '../auth/session-cookie.js';
import type { ResolvedCoreConfig } from '../config/options.js';
import { TELESCOPE_CONFIG, TELESCOPE_DASHBOARD_AUTH } from './telescope.options.js';

interface LoginBody {
  username?: unknown;
  password?: unknown;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Mints/clears the dashboard session cookie. Mounted on a SEPARATE controller
 * from the gated API so it is NOT behind `TelescopeGuard` — these endpoints
 * CREATE the session the gate checks for.
 */
@Controller('telescope/api/auth')
export class TelescopeAuthController {
  private readonly logger = new Logger(TelescopeAuthController.name);
  /** One warn per hook kind, so a flaky hook doesn't spam logs every request. */
  private readonly warnedHooks = new Set<string>();

  constructor(
    @Inject(TELESCOPE_DASHBOARD_AUTH)
    private readonly auth: ResolvedDashboardAuth | null,
    @Inject(TELESCOPE_CONFIG) private readonly config: ResolvedCoreConfig,
  ) {}

  // Mode A: the host frontend (carrying its own auth) POSTs here; the host hook
  // validates the raw request and returns the session user (or null to deny).
  @Post('session')
  @HttpCode(204)
  async session(
    @Req() request: unknown,
    @Res({ passthrough: true }) response: unknown,
  ): Promise<void> {
    const auth = this.requireAuth();
    if (!auth.session) {
      // Mode A not configured => the endpoint doesn't exist for this host.
      throw new NotFoundException();
    }
    const user = await this.runHook('session', () => auth.session?.(request) ?? null);
    if (!user) throw new UnauthorizedException();
    this.mint(user, request, response);
  }

  // Mode B: built-in login. Validates the body shape, runs the host hook with a
  // uniform 401 (no user-enumeration: same response for unknown user / bad pass).
  @Post('login')
  @HttpCode(204)
  async login(
    @Body() body: LoginBody,
    @Req() request: unknown,
    @Res({ passthrough: true }) response: unknown,
  ): Promise<void> {
    const auth = this.requireAuth();
    if (!auth.login) {
      throw new NotFoundException();
    }
    if (
      body === null ||
      typeof body !== 'object' ||
      !isString(body.username) ||
      !isString(body.password)
    ) {
      throw new BadRequestException('Body must include string `username` and `password`.');
    }
    const username = body.username;
    const password = body.password;
    const user = await this.runHook('login', () => auth.login?.(username, password) ?? null);
    if (!user) throw new UnauthorizedException({ message: 'Invalid credentials' });
    this.mint(user, request, response);
  }

  @Post('logout')
  @HttpCode(204)
  logout(@Req() request: unknown, @Res({ passthrough: true }) response: unknown): void {
    // Best-effort: even without dashboardAuth configured, clearing is harmless.
    clearSessionCookie({ telescopePath: this.config.path, request, response });
  }

  // The UNauthenticated SPA learns which AuthScreen to render from the 401 body
  // here (meta stays behind the gate). A valid cookie returns the user.
  @Get('me')
  me(@Req() request: unknown): { user: { id: string; name?: string; roles: string[] } } {
    const auth = this.requireAuth();
    const cookieValue = parseCookieHeader(readCookieHeader(request))[SESSION_COOKIE_NAME];
    const session =
      cookieValue !== undefined ? verifySessionCookie(cookieValue, { secret: auth.secret }) : null;
    if (!session) {
      throw new UnauthorizedException({ auth: { modes: auth.modes } });
    }
    return {
      user: {
        id: session.sub,
        ...(session.name !== undefined ? { name: session.name } : {}),
        roles: session.roles,
      },
    };
  }

  private requireAuth(): ResolvedDashboardAuth {
    // The auth controller is only registered when dashboardAuth is configured,
    // so this is a defensive guard rather than a reachable runtime path.
    if (!this.auth) throw new NotFoundException();
    return this.auth;
  }

  private mint(user: TelescopeSessionUser, request: unknown, response: unknown): void {
    const auth = this.requireAuth();
    issueSessionCookie(user, {
      auth,
      telescopePath: this.config.path,
      request,
      response,
    });
  }

  /**
   * Run a host hook defensively: a throw is treated as a denial (null) and
   * warn-logged once per kind, so a buggy hook never 500s the endpoint into a
   * stack leak nor floods the logs.
   */
  private async runHook(
    kind: string,
    run: () => Promise<TelescopeSessionUser | null> | TelescopeSessionUser | null,
  ): Promise<TelescopeSessionUser | null> {
    try {
      return (await run()) ?? null;
    } catch (error) {
      if (!this.warnedHooks.has(kind)) {
        this.warnedHooks.add(kind);
        this.logger.warn(
          `Telescope dashboardAuth ${kind} hook threw; treating as denial. ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return null;
    }
  }
}
