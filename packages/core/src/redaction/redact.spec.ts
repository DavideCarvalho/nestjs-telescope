// packages/core/src/redaction/redact.spec.ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_REDACT_KEYS, redact, redactBounded } from './redact.js';

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

describe('redact bounds (incident fix)', () => {
  it('cuts off nesting beyond maxDepth with the depth marker', () => {
    // depth 0 root, then nest deeper than the default of 8.
    let leaf: Record<string, unknown> = { value: 'deep' };
    for (let i = 0; i < 12; i++) {
      leaf = { next: leaf };
    }
    const out = redact(leaf, {}) as Record<string, any>;
    // Walk down to where the cut should be: at depth 8 we get the marker.
    let cursor: any = out;
    let sawMarker = false;
    for (let i = 0; i < 12; i++) {
      if (cursor === '[Truncated: depth]') {
        sawMarker = true;
        break;
      }
      cursor = cursor?.next;
    }
    expect(sawMarker).toBe(true);
  });

  it('truncates a long string to maxStringLength plus a suffix', () => {
    const long = 'a'.repeat(10_000);
    const out = redact({ blob: long }, {}) as Record<string, any>;
    expect(out.blob).toBe(`${'a'.repeat(8_192)}…[truncated]`);
    expect(out.blob.length).toBe(8_192 + '…[truncated]'.length);
  });

  it('truncates a long array to maxArrayLength plus a count marker', () => {
    const items = Array.from({ length: 500 }, (_, index) => index);
    const out = redact({ items }, {}) as Record<string, any>;
    expect(out.items).toHaveLength(201);
    expect(out.items[200]).toBe('[Truncated: 200 of 500 items]');
    expect(out.items[0]).toBe(0);
    expect(out.items[199]).toBe(199);
  });

  it('exhausts the node budget on a wide graph and prunes with the size marker', () => {
    // A wide object: far more keys than maxNodes once you count the root + leaves.
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 10_000; i++) {
      wide[`k${i}`] = { v: i };
    }
    const result = redactBounded(wide, {});
    expect(result.truncated).toBe(true);
    const values = Object.values(result.value as Record<string, unknown>);
    expect(values.some((value) => value === '[Truncated: size]')).toBe(true);
  });

  it('still detects circular references within the bounds', () => {
    const node: Record<string, unknown> = { name: 'davi' };
    node.self = node;
    const out = redact(node, {}) as Record<string, any>;
    expect(out.name).toBe('davi');
    expect(out.self).toBe('[Circular]');
  });

  it('still applies masking within the bounds', () => {
    const out = redact({ a: { password: 'p', name: 'davi' } }, {}) as Record<string, any>;
    expect(out.a.password).toBe('[REDACTED]');
    expect(out.a.name).toBe('davi');
  });

  it('applies the default bounds when options omit them', () => {
    const result = redactBounded({ blob: 'x'.repeat(9_000) }, {});
    expect(result.truncated).toBe(true);
  });

  it('lets the caller override each bound', () => {
    // A tiny override should clip what the generous defaults would keep.
    const out = redact({ s: 'abcdef' }, { maxStringLength: 3 }) as Record<string, any>;
    expect(out.s).toBe('abc…[truncated]');

    const arr = redact({ a: [1, 2, 3, 4] }, { maxArrayLength: 2 }) as Record<string, any>;
    expect(arr.a).toEqual([1, 2, '[Truncated: 2 of 4 items]']);

    const deep = redact({ a: { b: { c: 1 } } }, { maxDepth: 1 }) as Record<string, any>;
    expect(deep.a).toBe('[Truncated: depth]');
  });

  it('produces byte-identical output for a normal-sized object (no regression)', () => {
    const normal = {
      sql: 'select * from users where id = ?',
      bindings: [42, 'davi', true, null],
      took: 1.4,
      user: { id: 7, email: 'davi@goflip.ai', roles: ['admin'] },
      headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
      nested: { a: { b: { c: { d: 'fine' } } } },
    };
    const result = redactBounded(normal, {});
    expect(result.truncated).toBe(false);
    // Masking still applied, everything else preserved exactly.
    expect(result.value).toEqual({
      ...normal,
      headers: { 'content-type': 'application/json', authorization: '[REDACTED]' },
    });
  });

  it('never throws on pathological input', () => {
    const bomb: Record<string, unknown> = {};
    let cursor = bomb;
    for (let i = 0; i < 50_000; i++) {
      const child: Record<string, unknown> = {};
      cursor.next = child;
      cursor = child;
    }
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 50_000; i++) {
      wide[`k${i}`] = 'x'.repeat(20_000);
    }
    expect(() => redact(bomb, {})).not.toThrow();
    expect(() => redact(wide, {})).not.toThrow();
    expect(() => redactBounded(Symbol('x') as unknown, {})).not.toThrow();
  });
});

describe('redact maxContentBytes (incident-class payloads)', () => {
  it('truncates a graph of MANY SMALL strings that slips under the other bounds', () => {
    // ~50KB across ~1000 nodes of 50-char strings: under maxNodes (5000), under
    // maxStringLength (8192), under maxArrayLength/maxDepth — exactly the
    // incident's ORM-user-graph shape. The byte budget must clip it.
    const wide: Record<string, string> = {};
    for (let index = 0; index < 1_000; index += 1) {
      wide[`field${index}`] = 'p'.repeat(50);
    }
    const result = redactBounded({ user: wide }, {});
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result.value).length).toBeLessThan(25_000);
  });

  it('is overridable and leaves content under the budget byte-identical', () => {
    const wide: Record<string, string> = {};
    for (let index = 0; index < 1_000; index += 1) {
      wide[`field${index}`] = 'p'.repeat(50);
    }
    const raised = redactBounded({ user: wide }, { maxContentBytes: 1_000_000 });
    expect(raised.truncated).toBe(false);
    expect(raised.value).toEqual({ user: wide });
  });
});
