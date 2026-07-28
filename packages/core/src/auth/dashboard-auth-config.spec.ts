// packages/core/src/auth/dashboard-auth-config.spec.ts
import { describe, expect, it } from 'vitest';
import { resolveDashboardAuth } from './dashboard-auth-config.js';

describe('resolveDashboardAuth', () => {
  it('returns null when dashboardAuth is unconfigured (behavior unchanged)', () => {
    expect(resolveDashboardAuth(undefined)).toBeNull();
  });

  it('throws at boot when the secret is missing', () => {
    expect(() =>
      // @ts-expect-error: exercising the missing-secret boot guard
      resolveDashboardAuth({ login: () => null }),
    ).toThrow(/secret/);
  });

  it('throws at boot when the secret is empty', () => {
    expect(() => resolveDashboardAuth({ secret: '', login: () => null })).toThrow(/secret/);
  });

  it('throws at boot when neither session nor login is provided', () => {
    expect(() => resolveDashboardAuth({ secret: 's' })).toThrow(/session.*login|at least one/);
  });

  it('resolves modes from the configured hooks', () => {
    const both = resolveDashboardAuth({
      secret: 's',
      session: () => null,
      login: () => null,
    });
    expect(both?.modes).toEqual(['session', 'login']);
    const sessionOnly = resolveDashboardAuth({ secret: 's', session: () => null });
    expect(sessionOnly?.modes).toEqual(['session']);
    const loginOnly = resolveDashboardAuth({ secret: 's', login: () => null });
    expect(loginOnly?.modes).toEqual(['login']);
  });

  it('throws at boot when only revalidate is provided (it cannot mint a session)', () => {
    expect(() => resolveDashboardAuth({ secret: 's'.repeat(32), revalidate: () => true })).toThrow(
      /session.*login|at least one/,
    );
  });

  it('does not list revalidate in modes', () => {
    const auth = resolveDashboardAuth({
      secret: 's'.repeat(32),
      session: () => null,
      revalidate: () => true,
    });
    expect(auth?.modes).toEqual(['session']);
  });

  it('defaults ttl to 8h and parses a custom duration string', () => {
    expect(resolveDashboardAuth({ secret: 's', login: () => null })?.ttlMs).toBe(
      8 * 60 * 60 * 1000,
    );
    expect(resolveDashboardAuth({ secret: 's', ttl: '15m', login: () => null })?.ttlMs).toBe(
      15 * 60 * 1000,
    );
  });

  it('throws (fail closed) when unauthenticatedPage is present but not a function', () => {
    expect(() =>
      resolveDashboardAuth({
        secret: 's',
        session: () => null,
        // @ts-expect-error — exercising the runtime guard for a non-TS caller
        unauthenticatedPage: '/my/login/page',
      }),
    ).toThrow(/`unauthenticatedPage` must be a function/);
  });

  it('carries unauthenticatedPage through to the resolved config', () => {
    const unauthenticatedPage = () => {};
    expect(
      resolveDashboardAuth({ secret: 's', session: () => null, unauthenticatedPage })
        ?.unauthenticatedPage,
    ).toBe(unauthenticatedPage);
  });

  it('is not a mode: a page hook alone cannot mint a session', () => {
    // The page hook renders a denial — it can never grant one. Without `session` or `login` there
    // is still no way to mint the cookie, so this must stay the same boot error as before.
    expect(() => resolveDashboardAuth({ secret: 's', unauthenticatedPage: () => {} })).toThrow(
      /at least one of/,
    );
  });
});
