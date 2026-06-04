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

  it('defaults ttl to 8h and parses a custom duration string', () => {
    expect(resolveDashboardAuth({ secret: 's', login: () => null })?.ttlMs).toBe(
      8 * 60 * 60 * 1000,
    );
    expect(resolveDashboardAuth({ secret: 's', ttl: '15m', login: () => null })?.ttlMs).toBe(
      15 * 60 * 1000,
    );
  });
});
