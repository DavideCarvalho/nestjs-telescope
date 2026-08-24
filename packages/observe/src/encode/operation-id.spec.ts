import { describe, expect, it } from 'vitest';
import { operationId } from './operation-id.js';

describe('operationId', () => {
  it('collapses uuid, all-digit and long-hex segments to :id', () => {
    expect(operationId('GET', '/api/base/3c07e056-08bf-4dcb-ae21-9d426fb204df/mel/focus/123')).toBe(
      'GET /api/base/:id/mel/focus/:id',
    );
    expect(operationId('GET', '/t/deadbeefdeadbeef01')).toBe('GET /t/:id');
  });

  it('drops the query string', () => {
    expect(operationId('POST', '/login?token=secret&next=/home')).toBe('POST /login');
  });

  it('omits the method when there is none', () => {
    expect(operationId(undefined, '/health')).toBe('/health');
    expect(operationId('', '/health')).toBe('/health');
  });

  it('leaves short hex and word segments alone', () => {
    expect(operationId('GET', '/orders/abc/deadbeef')).toBe('GET /orders/abc/deadbeef');
  });
});
