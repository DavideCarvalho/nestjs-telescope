// packages/core/src/redaction/redact.spec.ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_REDACT_KEYS, redact } from './redact.js';

describe('redact', () => {
  it('masks default-sensitive keys case-insensitively at any depth', () => {
    const input = { user: { Password: 'p', token: 't', name: 'davi' }, ok: 1 };
    const out = redact(input, {}) as Record<string, any>;
    expect(out.user.Password).toBe('[REDACTED]');
    expect(out.user.token).toBe('[REDACTED]');
    expect(out.user.name).toBe('davi');
    expect(out.ok).toBe(1);
  });

  it('does not mutate the input', () => {
    const input = { password: 'secret' };
    redact(input, {});
    expect(input.password).toBe('secret');
  });

  it('masks caller-specified extra keys and dot-paths', () => {
    const input = { headers: { 'x-api-key': 'k' }, body: { ssn: '123' } };
    const out = redact(input, { keys: ['x-api-key'], paths: ['body.ssn'] }) as Record<string, any>;
    expect(out.headers['x-api-key']).toBe('[REDACTED]');
    expect(out.body.ssn).toBe('[REDACTED]');
  });

  it('handles arrays and leaves primitives/null alone', () => {
    expect(redact(null, {})).toBeNull();
    expect(redact(5, {})).toBe(5);
    const out = redact([{ password: 'x' }, { keep: 1 }], {}) as any[];
    expect(out[0].password).toBe('[REDACTED]');
    expect(out[1].keep).toBe(1);
  });

  it('includes the documented default keys', () => {
    expect(DEFAULT_REDACT_KEYS).toContain('authorization');
    expect(DEFAULT_REDACT_KEYS).toContain('password');
    expect(DEFAULT_REDACT_KEYS).toContain('secret');
  });

  it('handles circular references without overflowing', () => {
    const node: Record<string, unknown> = { password: 'x', name: 'davi' };
    node.self = node;
    const out = redact(node, {}) as Record<string, any>;
    expect(out.password).toBe('[REDACTED]');
    expect(out.name).toBe('davi');
    expect(out.self).toBe('[Circular]');
  });

  it('uses the configured mask string', () => {
    expect((redact({ password: 'x' }, { mask: '***' }) as Record<string, any>).password).toBe(
      '***',
    );
  });

  it('does not flag a non-cyclic shared reference as circular', () => {
    const shared = { keep: 1 };
    const out = redact({ a: shared, b: shared }, {}) as Record<string, any>;
    expect(out.a).toEqual({ keep: 1 });
    expect(out.b).toEqual({ keep: 1 });
    expect(out.b).not.toBe('[Circular]');
  });
});
