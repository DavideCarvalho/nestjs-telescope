// packages/core/src/auth/cookie-header.spec.ts
import { describe, expect, it } from 'vitest';
import { parseCookieHeader, serializeSetCookie } from './cookie-header.js';

describe('parseCookieHeader', () => {
  it('parses a multi-cookie header into a name→value map', () => {
    const parsed = parseCookieHeader('a=1; telescope_session=abc.def; b=2');
    expect(parsed.a).toBe('1');
    expect(parsed.telescope_session).toBe('abc.def');
    expect(parsed.b).toBe('2');
  });

  it('returns an empty map for undefined/empty input', () => {
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader('')).toEqual({});
  });

  it('URL-decodes values and strips wrapping quotes', () => {
    expect(parseCookieHeader('x=%20space%20').x).toBe(' space ');
    expect(parseCookieHeader('x="quoted"').x).toBe('quoted');
  });

  it('skips malformed segments without throwing', () => {
    const parsed = parseCookieHeader('=novalue; nokey; good=1');
    expect(parsed.good).toBe('1');
    expect(Object.keys(parsed)).toEqual(['good']);
  });

  it('keeps the first occurrence of a duplicated name', () => {
    expect(parseCookieHeader('dup=first; dup=second').dup).toBe('first');
  });
});

describe('serializeSetCookie', () => {
  it('always sets HttpOnly + SameSite=Lax and the given path/max-age', () => {
    const cookie = serializeSetCookie('telescope_session', 'v', {
      path: '/telescope',
      maxAgeSeconds: 3600,
      secure: false,
    });
    expect(cookie).toContain('telescope_session=v');
    expect(cookie).toContain('Path=/telescope');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=3600');
    expect(cookie).not.toContain('Secure');
  });

  it('adds Secure when secure is true', () => {
    const cookie = serializeSetCookie('telescope_session', 'v', {
      path: '/telescope',
      maxAgeSeconds: 3600,
      secure: true,
    });
    expect(cookie).toContain('Secure');
  });

  it('clears with an empty value, Max-Age=0 and a past Expires', () => {
    const cookie = serializeSetCookie('telescope_session', 'ignored', {
      path: '/telescope',
      maxAgeSeconds: 3600,
      secure: false,
      clear: true,
    });
    expect(cookie).toContain('telescope_session=;');
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  });

  it('URL-encodes the value', () => {
    const cookie = serializeSetCookie('n', 'a b', {
      path: '/telescope',
      maxAgeSeconds: 1,
      secure: false,
    });
    expect(cookie).toContain('n=a%20b');
  });
});
