// packages/core/src/nest/platform-request.spec.ts
import { describe, expect, it } from 'vitest';
import { normalizeRequest } from './platform-request.js';

describe('normalizeRequest', () => {
  it('reads method, url, headers, and ip from a raw Node request', () => {
    const req = {
      method: 'GET',
      url: '/orders/42',
      headers: { 'x-trace': 'abc' },
      socket: { remoteAddress: '10.0.0.1' },
    };
    expect(normalizeRequest(req)).toEqual({
      method: 'GET',
      url: '/orders/42',
      headers: { 'x-trace': 'abc' },
      ip: '10.0.0.1',
    });
  });

  it('prefers originalUrl when present (Express) and falls back to url', () => {
    expect(
      normalizeRequest({ method: 'POST', originalUrl: '/a', url: '/b', headers: {} }).url,
    ).toBe('/a');
    expect(normalizeRequest({ method: 'POST', url: '/b', headers: {} }).url).toBe('/b');
  });

  it('defaults missing fields safely', () => {
    expect(normalizeRequest({})).toEqual({ method: 'UNKNOWN', url: '', headers: {}, ip: null });
    expect(normalizeRequest(null)).toEqual({ method: 'UNKNOWN', url: '', headers: {}, ip: null });
  });
});
