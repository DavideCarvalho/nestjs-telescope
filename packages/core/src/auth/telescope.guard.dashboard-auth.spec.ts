// packages/core/src/auth/telescope.guard.dashboard-auth.spec.ts
import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config/resolve-config.js';
import { TelescopeGuard } from '../nest/telescope.guard.js';
import type { TelescopeModuleOptions } from '../nest/telescope.options.js';
import type { DashboardAuthOptions } from './dashboard-auth-config.js';
import { resolveDashboardAuth } from './dashboard-auth-config.js';
import { signSessionCookie } from './session-cookie.js';

const SECRET = 'guard-spec-secret-key-0123456789-abcdef';
/** Secret used by the revalidate fixtures below, matching the brief's `'s'.repeat(32)`. */
const REVALIDATE_SECRET = 's'.repeat(32);
/** `dashboardAuth`'s default TTL ('8h'), in ms — matches the `guardWith` fixtures, which don't set `ttl`. */
const REVALIDATE_TTL_MS = 8 * 60 * 60 * 1000;

/** Minimal Node-response double recording Set-Cookie writes. */
function makeResponse(): {
  raw: { getHeader: (n: string) => unknown; setHeader: (n: string, v: unknown) => void };
  setCookies: () => string[];
} {
  const headers: Record<string, unknown> = {};
  return {
    raw: {
      getHeader: (name) => headers[name.toLowerCase()],
      setHeader: (name, value) => {
        headers[name.toLowerCase()] = value;
      },
    },
    setCookies: () => {
      const current = headers['set-cookie'];
      return Array.isArray(current)
        ? current.filter((c): c is string => typeof c === 'string')
        : [];
    },
  };
}

function makeContext(request: unknown, response: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ExecutionContext;
}

function makeGuard(
  options: TelescopeModuleOptions,
  dashboardAuth = resolveDashboardAuth(options.dashboardAuth),
): TelescopeGuard {
  return new TelescopeGuard(options, dashboardAuth, resolveConfig(options));
}

/** `TelescopeGuard` configured with just a `dashboardAuth` (no other module options). */
function guardWith(authOptions: DashboardAuthOptions): TelescopeGuard {
  return makeGuard({ dashboardAuth: authOptions });
}

/** `ExecutionContext` over `request`, with a throwaway response when the caller won't inspect it. */
function contextFor(request: unknown, response: unknown = makeResponse().raw): ExecutionContext {
  return makeContext(request, response);
}

/** A request bearing a signed cookie issued `now` (well within the first 50% of the TTL). */
function requestWithFreshCookie(): { headers: { cookie: string } } {
  const value = signSessionCookie(
    { id: 'u1', roles: ['admin'] },
    { secret: REVALIDATE_SECRET, ttlMs: REVALIDATE_TTL_MS, now: Date.now() },
  );
  return { headers: { cookie: `telescope_session=${value}` } };
}

/** A request bearing a signed cookie issued just past 50% of the TTL (renewal/revalidation due). */
function requestWithHalfLifeCookie(): { headers: { cookie: string } } {
  const issuedAt = Date.now() - (REVALIDATE_TTL_MS / 2 + 60_000);
  const value = signSessionCookie(
    { id: 'u1', roles: ['admin'] },
    { secret: REVALIDATE_SECRET, ttlMs: REVALIDATE_TTL_MS, now: issuedAt },
  );
  return { headers: { cookie: `telescope_session=${value}` } };
}

describe('TelescopeGuard with dashboardAuth', () => {
  const authOptions: TelescopeModuleOptions = {
    dashboardAuth: { secret: SECRET, login: () => null },
  };

  it('throws 401 when no cookie is present', async () => {
    const guard = makeGuard(authOptions);
    const ctx = makeContext({ headers: {} }, makeResponse().raw);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws 401 when the cookie is invalid/tampered', async () => {
    const guard = makeGuard(authOptions);
    const ctx = makeContext(
      { headers: { cookie: 'telescope_session=garbage.value' } },
      makeResponse().raw,
    );
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('allows a valid cookie and attaches the session to the request', async () => {
    const guard = makeGuard(authOptions);
    const value = signSessionCookie(
      { id: 'u1', roles: ['admin'] },
      {
        secret: SECRET,
        ttlMs: 8 * 60 * 60 * 1000,
        now: Date.now(),
      },
    );
    const request: Record<string, unknown> = { headers: { cookie: `telescope_session=${value}` } };
    const ctx = makeContext(request, makeResponse().raw);
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(request.telescopeSession).toMatchObject({ sub: 'u1', roles: ['admin'] });
  });

  it('still ANDs the authorizer (valid cookie but authorizer denies => false)', async () => {
    const guard = makeGuard({
      dashboardAuth: { secret: SECRET, login: () => null },
      authorizer: () => false,
    });
    const value = signSessionCookie(
      { id: 'u1' },
      {
        secret: SECRET,
        ttlMs: 8 * 60 * 60 * 1000,
        now: Date.now(),
      },
    );
    const ctx = makeContext(
      { headers: { cookie: `telescope_session=${value}` } },
      makeResponse().raw,
    );
    expect(await guard.canActivate(ctx)).toBe(false);
  });

  it('slides renewal: re-issues a cookie once past 50% of the TTL', async () => {
    const guard = makeGuard({ dashboardAuth: { secret: SECRET, ttl: '2h', login: () => null } });
    const ttlMs = 2 * 60 * 60 * 1000;
    // Issued 90 minutes ago (> 50% of a 2h TTL) but not yet expired.
    const issuedAt = Date.now() - 90 * 60 * 1000;
    const value = signSessionCookie({ id: 'u1' }, { secret: SECRET, ttlMs, now: issuedAt });
    const response = makeResponse();
    const ctx = makeContext({ headers: { cookie: `telescope_session=${value}` } }, response.raw);
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(response.setCookies().some((c) => c.startsWith('telescope_session='))).toBe(true);
  });

  it('does NOT re-issue a cookie when still within the first 50% of the TTL', async () => {
    const guard = makeGuard({ dashboardAuth: { secret: SECRET, ttl: '2h', login: () => null } });
    const ttlMs = 2 * 60 * 60 * 1000;
    const value = signSessionCookie({ id: 'u1' }, { secret: SECRET, ttlMs, now: Date.now() });
    const response = makeResponse();
    const ctx = makeContext({ headers: { cookie: `telescope_session=${value}` } }, response.raw);
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(response.setCookies()).toEqual([]);
  });
});

describe('TelescopeGuard revalidate hook (on the renewal path)', () => {
  it('does not call revalidate before half the TTL has passed', async () => {
    const revalidate = vi.fn().mockResolvedValue(true);
    const guard = guardWith({ secret: REVALIDATE_SECRET, session: () => null, revalidate });
    await guard.canActivate(contextFor(requestWithFreshCookie()));
    expect(revalidate).not.toHaveBeenCalled();
  });

  it('renews when revalidate approves', async () => {
    const guard = guardWith({
      secret: REVALIDATE_SECRET,
      session: () => null,
      revalidate: () => true,
    });
    await expect(guard.canActivate(contextFor(requestWithHalfLifeCookie()))).resolves.toBe(true);
  });

  it('401s and clears the cookie when revalidate rejects', async () => {
    const guard = guardWith({
      secret: REVALIDATE_SECRET,
      session: () => null,
      revalidate: () => false,
    });
    const response = makeResponse();
    await expect(
      guard.canActivate(contextFor(requestWithHalfLifeCookie(), response.raw)),
    ).rejects.toThrow(UnauthorizedException);
    expect(response.setCookies()[0]).toContain('Max-Age=0');
  });

  it('fails closed when revalidate throws', async () => {
    const guard = guardWith({
      secret: REVALIDATE_SECRET,
      session: () => null,
      revalidate: () => {
        throw new Error('db down');
      },
    });
    await expect(guard.canActivate(contextFor(requestWithHalfLifeCookie()))).rejects.toThrow(
      UnauthorizedException,
    );
  });
});

describe('TelescopeGuard without dashboardAuth (unchanged)', () => {
  const original = process.env.NODE_ENV;

  it('uses the authorizer when set', async () => {
    const ctx = makeContext({ url: '/telescope/api/meta' }, makeResponse().raw);
    expect(await new TelescopeGuard({ authorizer: () => true }).canActivate(ctx)).toBe(true);
    expect(await new TelescopeGuard({ authorizer: () => false }).canActivate(ctx)).toBe(false);
  });

  it('defaults to allow outside production', async () => {
    process.env.NODE_ENV = 'development';
    const ctx = makeContext({ url: '/telescope/api/meta' }, makeResponse().raw);
    expect(await new TelescopeGuard({}).canActivate(ctx)).toBe(true);
    process.env.NODE_ENV = original;
  });
});
