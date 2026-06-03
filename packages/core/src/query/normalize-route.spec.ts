// packages/core/src/query/normalize-route.spec.ts
import { describe, expect, it } from 'vitest';
import { normalizeRoute } from './normalize-route.js';

describe('normalizeRoute', () => {
  it('replaces a UUID segment with :id', () => {
    expect(normalizeRoute('GET', '/api/base/3c07e056-08bf-4dcb-ae21-9d426fb204df/mel')).toBe(
      'GET /api/base/:id/mel',
    );
  });

  it('replaces an all-digits segment with :id', () => {
    expect(normalizeRoute('GET', '/api/base/123/mel')).toBe('GET /api/base/:id/mel');
  });

  it('replaces a long hex segment with :id', () => {
    expect(normalizeRoute('GET', '/api/object/0123456789abcdef0123')).toBe('GET /api/object/:id');
  });

  it('replaces multiple mixed id segments', () => {
    expect(
      normalizeRoute('GET', '/api/base/3c07e056-08bf-4dcb-ae21-9d426fb204df/mel/focus/123'),
    ).toBe('GET /api/base/:id/mel/focus/:id');
  });

  it('strips the query string', () => {
    expect(normalizeRoute('GET', '/api/base/123?expand=true&page=2')).toBe('GET /api/base/:id');
  });

  it('leaves the root path untouched', () => {
    expect(normalizeRoute('GET', '/')).toBe('GET /');
  });

  it('preserves a trailing slash structurally', () => {
    expect(normalizeRoute('GET', '/api/base/123/')).toBe('GET /api/base/:id/');
  });

  it('does not treat a short hex word as an id', () => {
    expect(normalizeRoute('GET', '/api/cafe/list')).toBe('GET /api/cafe/list');
  });

  it('preserves the method verb', () => {
    expect(normalizeRoute('POST', '/api/base/123')).toBe('POST /api/base/:id');
  });
});
