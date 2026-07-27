// packages/core/src/nest/telescope.guard.ts
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { attachSession, readCookieHeader } from '../auth/auth-request.js';
import { parseCookieHeader } from '../auth/cookie-header.js';
import type { ResolvedDashboardAuth } from '../auth/dashboard-auth-config.js';
import {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  issueSessionCookie,
} from '../auth/session-cookie-io.js';
import { type TelescopeSession, verifySessionCookie } from '../auth/session-cookie.js';
import type { ResolvedCoreConfig } from '../config/options.js';
import {
  TELESCOPE_CONFIG,
  TELESCOPE_DASHBOARD_AUTH,
  TELESCOPE_OPTIONS,
  type TelescopeModuleOptions,
} from './telescope.options.js';

@Injectable()
export class TelescopeGuard implements CanActivate {
  constructor(
    @Inject(TELESCOPE_OPTIONS) private readonly options: TelescopeModuleOptions,
    @Inject(TELESCOPE_DASHBOARD_AUTH)
    private readonly dashboardAuth: ResolvedDashboardAuth | null = null,
    @Inject(TELESCOPE_CONFIG) private readonly config: ResolvedCoreConfig | null = null,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<unknown>();
    // Cookie-session gate: when configured, a valid session cookie is REQUIRED
    // for every guarded route (the auth endpoints live on a separate, ungated
    // controller). The session is attached to the request, then `authorizer`
    // still runs (AND semantics) below.
    if (this.dashboardAuth) {
      const session = this.verifyRequestSession(request);
      if (!session) {
        // Absent/invalid/expired cookie => 401 (not 403): the SPA reads this as
        // "log in", distinct from authorizer's 403 "logged in but forbidden".
        throw new UnauthorizedException();
      }
      attachSession(request, session);
      if (!(await this.maybeRenew(http.getResponse<unknown>(), request, session))) {
        // Revoked mid-session: same 401 as an absent cookie.
        throw new UnauthorizedException();
      }
      return this.runAuthorizer(request);
    }
    if (this.options.authorizer) {
      return this.runAuthorizer(request);
    }
    // Safe default: open in dev, closed in production. An unset NODE_ENV is
    // treated as non-production (local/dev context).
    return process.env.NODE_ENV !== 'production';
  }

  private verifyRequestSession(request: unknown): TelescopeSession | null {
    const auth = this.dashboardAuth;
    if (!auth) return null;
    const cookieValue = parseCookieHeader(readCookieHeader(request))[SESSION_COOKIE_NAME];
    if (cookieValue === undefined) return null;
    return verifySessionCookie(cookieValue, { secret: auth.secret });
  }

  /**
   * Sliding renewal + revalidation: when a valid cookie is past 50% of its TTL, re-issue a fresh one
   * so active users never get logged out mid-session — but first let the host's `revalidate` hook
   * re-check the user, so a deactivated or demoted operator loses access instead of riding a
   * self-renewing cookie. Returns `false` when the session was revoked (cookie already cleared).
   */
  private async maybeRenew(
    response: unknown,
    request: unknown,
    session: TelescopeSession,
  ): Promise<boolean> {
    const auth = this.dashboardAuth;
    if (!auth) return true;
    const now = Date.now();
    if (now - session.iat <= auth.ttlMs / 2) return true;
    const user = {
      id: session.sub,
      ...(session.name !== undefined ? { name: session.name } : {}),
      roles: session.roles,
    };
    if (auth.revalidate) {
      let allowed: boolean;
      try {
        allowed = await auth.revalidate(user);
      } catch {
        allowed = false; // Fail closed.
      }
      if (!allowed) {
        clearSessionCookie({ telescopePath: this.config?.path ?? 'telescope', request, response });
        return false;
      }
    }
    issueSessionCookie(user, {
      auth,
      telescopePath: this.config?.path ?? 'telescope',
      request,
      response,
      now,
    });
    return true;
  }

  private async runAuthorizer(request: unknown): Promise<boolean> {
    if (!this.options.authorizer) return true;
    try {
      return await this.options.authorizer({ request });
    } catch {
      // Fail closed: a throwing authorizer denies access (clean 403),
      // never accidentally grants it or surfaces a 500.
      return false;
    }
  }
}
