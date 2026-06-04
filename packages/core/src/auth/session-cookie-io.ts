// packages/core/src/auth/session-cookie-io.ts
import { isHttpsRequest } from './auth-request.js';
import { appendSetCookie } from './auth-response.js';
import { serializeSetCookie } from './cookie-header.js';
import type { ResolvedDashboardAuth } from './dashboard-auth-config.js';
import { type TelescopeSessionUser, signSessionCookie } from './session-cookie.js';

/** Cookie name carrying the signed dashboard session. */
export const SESSION_COOKIE_NAME = 'telescope_session';

/** Cookie path = the dashboard mount path, so the cookie scopes to `/<path>`. */
function cookiePath(telescopePath: string): string {
  return `/${telescopePath}`;
}

/**
 * Sign a fresh session for `user` and append it as a `Set-Cookie` on the
 * response, scoped to the dashboard path and `Secure` when the request is https.
 */
export function issueSessionCookie(
  user: TelescopeSessionUser,
  context: {
    auth: ResolvedDashboardAuth;
    telescopePath: string;
    request: unknown;
    response: unknown;
    now?: number;
  },
): void {
  const value = signSessionCookie(user, {
    secret: context.auth.secret,
    ttlMs: context.auth.ttlMs,
    ...(context.now !== undefined ? { now: context.now } : {}),
  });
  const cookie = serializeSetCookie(SESSION_COOKIE_NAME, value, {
    path: cookiePath(context.telescopePath),
    maxAgeSeconds: Math.floor(context.auth.ttlMs / 1000),
    secure: isHttpsRequest(context.request),
  });
  appendSetCookie(context.response, cookie);
}

/** Append a cookie-clearing `Set-Cookie` (Max-Age=0) scoped to the dashboard path. */
export function clearSessionCookie(context: {
  telescopePath: string;
  request: unknown;
  response: unknown;
}): void {
  const cookie = serializeSetCookie(SESSION_COOKIE_NAME, '', {
    path: cookiePath(context.telescopePath),
    maxAgeSeconds: 0,
    secure: isHttpsRequest(context.request),
    clear: true,
  });
  appendSetCookie(context.response, cookie);
}
