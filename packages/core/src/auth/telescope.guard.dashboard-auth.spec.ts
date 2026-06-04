// packages/core/src/auth/telescope.guard.dashboard-auth.spec.ts
import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config/resolve-config.js';
import { TelescopeGuard } from '../nest/telescope.guard.js';
import type { TelescopeModuleOptions } from '../nest/telescope.options.js';
import { resolveDashboardAuth } from './dashboard-auth-config.js';
import { signSessionCookie } from './session-cookie.js';

const SECRET = 'guard-spec-secret-key-0123456789-abcdef';

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
