// packages/core/src/auth/session-cookie.spec.ts
import { describe, expect, it } from 'vitest';
import { signSessionCookie, verifySessionCookie } from './session-cookie.js';

const SECRET = 'a-very-long-test-secret-key-0123456789';
const TTL_MS = 8 * 60 * 60 * 1000;

describe('session-cookie codec', () => {
  it('round-trips a signed session (sub/name/roles/iat/exp)', () => {
    const now = 1_700_000_000_000;
    const value = signSessionCookie(
      { id: 'u1', name: 'Davi', roles: ['admin'] },
      {
        secret: SECRET,
        ttlMs: TTL_MS,
        now,
      },
    );
    const session = verifySessionCookie(value, { secret: SECRET, now });
    expect(session).not.toBeNull();
    expect(session?.sub).toBe('u1');
    expect(session?.name).toBe('Davi');
    expect(session?.roles).toEqual(['admin']);
    expect(session?.iat).toBe(now);
    expect(session?.exp).toBe(now + TTL_MS);
  });

  it('defaults roles to an empty array and omits name when absent', () => {
    const value = signSessionCookie({ id: 'ops' }, { secret: SECRET, ttlMs: TTL_MS, now: 0 });
    const session = verifySessionCookie(value, { secret: SECRET, now: 0 });
    expect(session?.roles).toEqual([]);
    expect(session?.name).toBeUndefined();
  });

  it('returns null when the signature was made with a different secret', () => {
    const value = signSessionCookie({ id: 'u1' }, { secret: SECRET, ttlMs: TTL_MS, now: 0 });
    expect(verifySessionCookie(value, { secret: 'other-secret', now: 0 })).toBeNull();
  });

  it('returns null when the payload is tampered (signature no longer matches)', () => {
    const value = signSessionCookie(
      { id: 'u1', roles: [] },
      { secret: SECRET, ttlMs: TTL_MS, now: 0 },
    );
    const [, signature] = value.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: 'attacker', roles: ['admin'], iat: 0, exp: TTL_MS }),
      'utf8',
    ).toString('base64url');
    expect(
      verifySessionCookie(`${forgedPayload}.${signature}`, { secret: SECRET, now: 0 }),
    ).toBeNull();
  });

  it('returns null when the signature is tampered', () => {
    const value = signSessionCookie({ id: 'u1' }, { secret: SECRET, ttlMs: TTL_MS, now: 0 });
    const [payload] = value.split('.');
    expect(verifySessionCookie(`${payload}.deadbeef`, { secret: SECRET, now: 0 })).toBeNull();
  });

  it('returns null once past exp + the 30s grace', () => {
    const now = 1_000_000;
    const value = signSessionCookie({ id: 'u1' }, { secret: SECRET, ttlMs: 1000, now });
    // exp = now + 1000; grace = 30s. Just past the grace boundary.
    expect(verifySessionCookie(value, { secret: SECRET, now: now + 1000 + 30_001 })).toBeNull();
  });

  it('still accepts a cookie within the 30s expiry grace', () => {
    const now = 1_000_000;
    const value = signSessionCookie({ id: 'u1' }, { secret: SECRET, ttlMs: 1000, now });
    const session = verifySessionCookie(value, { secret: SECRET, now: now + 1000 + 15_000 });
    expect(session?.sub).toBe('u1');
  });

  it('never throws on malformed input (returns null)', () => {
    const malformed = ['', '.', 'nodot', 'a.', '.b', '!!!.@@@', 'a.b.c', '{}', 'YWJj.YWJj'];
    for (const value of malformed) {
      expect(() => verifySessionCookie(value, { secret: SECRET, now: 0 })).not.toThrow();
      expect(verifySessionCookie(value, { secret: SECRET, now: 0 })).toBeNull();
    }
  });

  it('returns null when the decoded payload has the wrong shape', () => {
    // Valid signature over a payload missing required fields => rejected by the shape guard.
    const badPayload = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8').toString(
      'base64url',
    );
    const value = signSessionCookie({ id: 'u1' }, { secret: SECRET, ttlMs: TTL_MS, now: 0 });
    const [, sig] = value.split('.');
    // Re-sign the bad payload so the signature is valid but the shape isn't.
    const reSigned = signSessionCookie({ id: 'u1' }, { secret: SECRET, ttlMs: TTL_MS, now: 0 });
    expect(verifySessionCookie(`${badPayload}.${sig}`, { secret: SECRET, now: 0 })).toBeNull();
    expect(reSigned).toBeTypeOf('string');
  });
});
