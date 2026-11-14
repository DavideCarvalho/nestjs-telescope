import { describe, expect, it } from 'vitest';
import { resolveConsoleSignOut, resolveConsoleViewer, viewerFromUser } from './console-shell.js';

describe('viewerFromUser', () => {
  it('prefers fullName, then name, then email; role, else the first of roles', () => {
    expect(viewerFromUser({ fullName: 'Ann Lee', email: 'ann@x.test', roles: ['admin'] })).toEqual({
      label: 'Ann Lee',
      email: 'ann@x.test',
      role: 'admin',
    });
    expect(viewerFromUser({ name: 'Bo', roles: [{ name: 'support' }] })).toEqual({
      label: 'Bo',
      role: 'support',
    });
    expect(viewerFromUser({ email: 'c@x.test', role: 'viewer' })).toEqual({
      label: 'c@x.test',
      email: 'c@x.test',
      role: 'viewer',
    });
  });

  it('is undefined for nothing usable', () => {
    expect(viewerFromUser(undefined)).toBeUndefined();
    expect(viewerFromUser({ id: 1 })).toBeUndefined();
    expect(viewerFromUser({ name: '  ' })).toBeUndefined();
  });
});

describe('resolveConsoleViewer', () => {
  it('reads request.user structurally without an option, swallowing a throwing getter', async () => {
    expect(await resolveConsoleViewer({ user: { email: 'a@x.test' } }, undefined)).toEqual({
      label: 'a@x.test',
      email: 'a@x.test',
    });
    expect(await resolveConsoleViewer({}, undefined)).toBeUndefined();
    const guarded = {
      get user(): unknown {
        throw new Error('not authenticated');
      },
    };
    expect(await resolveConsoleViewer(guarded, undefined)).toBeUndefined();
  });

  it('uses the option (sync or async), cleaning its answer; a throw means no viewer', async () => {
    const req = { user: { email: 'ignored@x.test' } };
    expect(
      await resolveConsoleViewer(req, async () => ({ label: ' Ops ', role: 'admin' })),
    ).toEqual({ label: 'Ops', role: 'admin' });
    expect(await resolveConsoleViewer(req, () => null)).toBeUndefined();
    expect(await resolveConsoleViewer(req, () => ({ label: '' }))).toBeUndefined();
    expect(
      await resolveConsoleViewer(req, () => {
        throw new Error('boom');
      }),
    ).toBeUndefined();
  });
});

describe('resolveConsoleSignOut', () => {
  const registry = { version: 1, entries: [], account: { signOut: '/account/logout' } };
  const withCsrf = { csrfToken: () => 'req-token' };

  it('uses the option first; a POST action carries a CSRF token', () => {
    expect(resolveConsoleSignOut(withCsrf, '/logout', registry)).toEqual({
      action: '/logout',
      csrfToken: 'req-token',
    });
    expect(
      resolveConsoleSignOut(withCsrf, { action: '/out', csrfToken: () => 'mine' }, registry),
    ).toEqual({ action: '/out', csrfToken: 'mine' });
    expect(resolveConsoleSignOut({}, { href: '/bye' }, registry)).toEqual({ href: '/bye' });
    expect(resolveConsoleSignOut({}, false, registry)).toBeUndefined();
  });

  it('falls back to the sign-out an account console announced on the registry', () => {
    expect(resolveConsoleSignOut({}, undefined, registry)).toEqual({ action: '/account/logout' });
    expect(
      resolveConsoleSignOut({}, undefined, { account: { signOut: { href: '/out' } } }),
    ).toEqual({ href: '/out' });
    expect(resolveConsoleSignOut({}, undefined, { version: 1, entries: [] })).toBeUndefined();
    expect(resolveConsoleSignOut({}, undefined, undefined)).toBeUndefined();
  });

  it('never emits anything but a same-origin path', () => {
    expect(resolveConsoleSignOut({}, 'https://evil.example/out', undefined)).toBeUndefined();
    expect(resolveConsoleSignOut({}, { href: '//evil.example' }, undefined)).toBeUndefined();
    expect(resolveConsoleSignOut({}, '/\\evil', undefined)).toBeUndefined();
    expect(
      resolveConsoleSignOut({}, undefined, { account: { signOut: 'javascript:alert(1)' } }),
    ).toBeUndefined();
  });

  it('ignores a CSRF token that is empty, not a string, or throws', () => {
    expect(resolveConsoleSignOut({ csrfToken: '' }, '/o', undefined)).toEqual({ action: '/o' });
    expect(resolveConsoleSignOut({ csrfToken: 3 }, '/o', undefined)).toEqual({ action: '/o' });
    const throwing = {
      csrfToken: () => {
        throw new Error('no session');
      },
    };
    expect(resolveConsoleSignOut(throwing, '/o', undefined)).toEqual({ action: '/o' });
  });
});
