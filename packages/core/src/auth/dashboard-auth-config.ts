// packages/core/src/auth/dashboard-auth-config.ts
import { durationToMs } from '../config/parse-duration.js';
import type { TelescopeSessionUser } from './session-cookie.js';

/** Host hook for Mode A — validates the host's own auth on the raw request. */
export type SessionHook = (
  request: unknown,
) => Promise<TelescopeSessionUser | null> | TelescopeSessionUser | null;

/** Host hook for Mode B — validates submitted credentials. */
export type LoginHook = (
  username: string,
  password: string,
) => Promise<TelescopeSessionUser | null> | TelescopeSessionUser | null;

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
}

export type AuthMode = 'session' | 'login';

/** Resolved, validated dashboard-auth config used by the guard/controller/meta. */
export interface ResolvedDashboardAuth {
  secret: string;
  ttlMs: number;
  modes: AuthMode[];
  session?: SessionHook;
  login?: LoginHook;
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
  const ttlMs = durationToMs(options.ttl ?? DEFAULT_TTL);
  return {
    secret: options.secret,
    ttlMs,
    modes,
    ...(options.session !== undefined ? { session: options.session } : {}),
    ...(options.login !== undefined ? { login: options.login } : {}),
  };
}
