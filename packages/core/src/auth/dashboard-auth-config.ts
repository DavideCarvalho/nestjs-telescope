// packages/core/src/auth/dashboard-auth-config.ts
import { durationToMs } from '../config/parse-duration.js';
import type { TelescopeHttpRequest } from '../nest/telescope.options.js';
import type { TelescopeSessionUser } from './session-cookie.js';

/** Host hook for Mode A — validates the host's own auth on the raw request. */
export type SessionHook = (
  request: TelescopeHttpRequest,
) => Promise<TelescopeSessionUser | null> | TelescopeSessionUser | null;

/** Host hook for Mode B — validates submitted credentials. */
export type LoginHook = (
  username: string,
  password: string,
) => Promise<TelescopeSessionUser | null> | TelescopeSessionUser | null;

/** Re-checks a live session on sliding renewal; see `DashboardAuthOptions.revalidate`. */
export type RevalidateHook = (session: TelescopeSessionUser) => Promise<boolean> | boolean;

/** What `unauthenticatedPage` receives. An object (not positional args) so fields can be added later. */
export interface UnauthenticatedPageContext {
  /** The platform-native request — Express' `Request`, Fastify's `FastifyRequest`. */
  request: unknown;
  /**
   * The platform-native response. The hook OWNS it: it must write AND end it. If it returns without
   * writing, the dashboard falls back to serving its SPA (whose auth screen then renders).
   */
  response: unknown;
  /** Where the dashboard is mounted (e.g. `/telescope`) — useful for a "back to it" link. */
  basePath: string;
}

/**
 * Host-owned page for an unauthenticated navigation to the dashboard.
 *
 * Without it, an unauthenticated visitor gets the SPA shell, which renders the built-in auth screen:
 * a generic "open this console from your application" card, generic because the library cannot know
 * who hosts it. This hook replaces that with the host's own page — and, because the decision happens
 * BEFORE the shell is served, the bundle stops loading at all for a visitor with no session.
 *
 * IMPORTANT: this hook is read by `TelescopeUiModule` (`@dudousxd/nestjs-telescope-ui`), which serves
 * the page — so the `dashboardAuth` carrying it must be passed to THAT module too, exactly like
 * `guards`. Setting it only on `TelescopeModule.forRoot` gates the API but leaves the page untouched.
 *
 * Only consulted under Mode-A-only. With `login` configured the SPA's own login form IS the way in,
 * so gating the shell would lock Mode B hosts out of their own dashboard.
 *
 * Fail-closed by construction: it only ever runs when the request has no valid session, and every
 * data route stays behind `TelescopeGuard` regardless. A hook that throws, or returns without
 * writing, falls back to serving the SPA — it cannot let anyone in.
 */
export type UnauthenticatedPageHook = (context: UnauthenticatedPageContext) => void | Promise<void>;

/** Author-facing `dashboardAuth` option (see TelescopeModuleOptions). */
export interface DashboardAuthOptions {
  /** REQUIRED HMAC-SHA256 signing key. Missing/empty => boot error (fail closed). */
  secret: string;
  /** Cookie TTL (duration string, reuses durationToMs). Default '8h'. */
  ttl?: string;
  /** Mode A. */
  session?: SessionHook;
  /** Mode B. */
  login?: LoginHook;
  /** Re-checks a live session on sliding renewal; see `RevalidateHook`. Not a mode — it cannot
   *  mint a session, only revoke one already minted by `session`/`login`. */
  revalidate?: RevalidateHook;
  /** Renders the host's own page for an unauthenticated navigation, in place of serving the SPA and
   *  letting its built-in auth screen render; see `UnauthenticatedPageHook`. Read by
   *  `TelescopeUiModule`, so pass this `dashboardAuth` to that module as well. Mode-A-only. */
  unauthenticatedPage?: UnauthenticatedPageHook;
}

export type AuthMode = 'session' | 'login';

/** Resolved, validated dashboard-auth config used by the guard/controller/meta. */
export interface ResolvedDashboardAuth {
  secret: string;
  ttlMs: number;
  modes: AuthMode[];
  session?: SessionHook;
  login?: LoginHook;
  revalidate?: RevalidateHook;
  unauthenticatedPage?: UnauthenticatedPageHook;
}

const DEFAULT_TTL = '8h';

/**
 * Validate + resolve `dashboardAuth`. Returns `null` when unconfigured (behavior
 * unchanged). Throws at boot (fail closed) when configured but missing a secret
 * or any hook — the host learns immediately rather than shipping an open or
 * un-mintable dashboard.
 */
export function resolveDashboardAuth(
  options: DashboardAuthOptions | undefined,
): ResolvedDashboardAuth | null {
  if (options === undefined) return null;
  if (typeof options.secret !== 'string' || options.secret === '') {
    throw new Error(
      'Telescope dashboardAuth: `secret` is required and must be a non-empty string ' +
        '(HMAC-SHA256 signing key, 32+ bytes recommended). Failing closed.',
    );
  }
  const modes: AuthMode[] = [];
  if (options.session !== undefined) modes.push('session');
  if (options.login !== undefined) modes.push('login');
  if (modes.length === 0) {
    throw new Error(
      'Telescope dashboardAuth: at least one of `session` or `login` must be ' +
        'provided (otherwise the cookie can never be minted).',
    );
  }
  if (
    options.unauthenticatedPage !== undefined &&
    typeof options.unauthenticatedPage !== 'function'
  ) {
    throw new Error('Telescope dashboardAuth: `unauthenticatedPage` must be a function.');
  }
  const ttlMs = durationToMs(options.ttl ?? DEFAULT_TTL);
  return {
    secret: options.secret,
    ttlMs,
    modes,
    ...(options.session !== undefined ? { session: options.session } : {}),
    ...(options.login !== undefined ? { login: options.login } : {}),
    ...(options.revalidate !== undefined ? { revalidate: options.revalidate } : {}),
    ...(options.unauthenticatedPage !== undefined
      ? { unauthenticatedPage: options.unauthenticatedPage }
      : {}),
  };
}
