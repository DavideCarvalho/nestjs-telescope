import { describe, expect, it } from 'vitest';
import { hmacTenantVerifier, resolveTenantToken, signTenantToken } from './tenant-auth.js';

describe('tenant auth', () => {
  it('derives the partition from a signed token', async () => {
    const verify = hmacTenantVerifier('secret');
    expect(await verify({ token: signTenantToken('shop', 'secret') })).toEqual({ tenant: 'shop' });
    expect(await verify({ token: signTenantToken('shop.eu', 'secret') })).toEqual({
      tenant: 'shop.eu',
    });
  });

  it('refuses tampered, foreign and expired tokens', async () => {
    const verify = hmacTenantVerifier('secret');
    const token = signTenantToken('shop', 'secret');
    expect(await verify({ token: token.replace('shop', 'bill') })).toBeNull();
    expect(await verify({ token: signTenantToken('shop', 'other') })).toBeNull();
    expect(await verify({ token: signTenantToken('shop', 'secret', { ttlMs: -1 }) })).toBeNull();
    expect(await verify({ token: undefined })).toBeNull();
  });

  it('accepts expiring tokens before they expire and rotates secrets', async () => {
    const verify = hmacTenantVerifier(['next', 'current']);
    expect(await verify({ token: signTenantToken('shop', 'current', { ttlMs: 60_000 }) })).toEqual({
      tenant: 'shop',
    });
    expect(await verify({ token: signTenantToken('shop', 'next') })).toEqual({ tenant: 'shop' });
  });

  it('stamps capabilities and resolves token sources', async () => {
    expect(
      await hmacTenantVerifier('s', ['telescope:ingest'])({ token: signTenantToken('a', 's') }),
    ).toEqual({ tenant: 'a', capabilities: ['telescope:ingest'] });
    expect(await resolveTenantToken('t')).toBe('t');
    expect(await resolveTenantToken(async () => 'u')).toBe('u');
  });
});
