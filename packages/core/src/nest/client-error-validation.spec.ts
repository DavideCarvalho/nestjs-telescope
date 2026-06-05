// packages/core/src/nest/client-error-validation.spec.ts
import { describe, expect, it } from 'vitest';
import { validateClientErrorBody } from './client-error-validation.js';

describe('validateClientErrorBody', () => {
  it('accepts a minimal body with just a message', () => {
    const result = validateClientErrorBody({ message: 'boom' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.message).toBe('boom');
      expect(result.value.name).toBeNull();
      expect(result.value.extra).toBeNull();
    }
  });

  it('rejects a non-object body', () => {
    expect(validateClientErrorBody('nope').ok).toBe(false);
    expect(validateClientErrorBody(null).ok).toBe(false);
    expect(validateClientErrorBody([]).ok).toBe(false);
  });

  it('rejects a missing or empty message', () => {
    expect(validateClientErrorBody({}).ok).toBe(false);
    expect(validateClientErrorBody({ message: '' }).ok).toBe(false);
    expect(validateClientErrorBody({ message: 5 }).ok).toBe(false);
  });

  it('rejects a non-string optional field rather than coercing it', () => {
    expect(validateClientErrorBody({ message: 'm', stack: 123 }).ok).toBe(false);
    expect(validateClientErrorBody({ message: 'm', url: { a: 1 } }).ok).toBe(false);
  });

  it('rejects a non-object extra', () => {
    expect(validateClientErrorBody({ message: 'm', extra: 'str' }).ok).toBe(false);
    expect(validateClientErrorBody({ message: 'm', extra: [1, 2] }).ok).toBe(false);
  });

  it('length-caps long strings', () => {
    const result = validateClientErrorBody({
      message: 'x'.repeat(5_000),
      stack: 's'.repeat(40_000),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.message.length).toBe(2 * 1024);
      expect(result.value.stack?.length).toBe(16 * 1024);
    }
  });

  it('passes user through untouched (tagged/redacted downstream)', () => {
    const result = validateClientErrorBody({ message: 'm', user: { id: 'u1', email: 'a@b.c' } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.user).toEqual({ id: 'u1', email: 'a@b.c' });
  });
});
