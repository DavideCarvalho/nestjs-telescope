// packages/mikro-orm/src/query-family-hash.spec.ts
import { describe, expect, it } from 'vitest';
import { queryFamilyHash } from './query-family-hash.js';

describe('queryFamilyHash', () => {
  it('hashes the same template identically regardless of bound values or whitespace', () => {
    const a = queryFamilyHash("select * from author where id = 1");
    const b = queryFamilyHash("select  *  from author  where id = 42");
    const c = queryFamilyHash("select * from author where id = ?");
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('distinguishes different templates', () => {
    expect(queryFamilyHash('select * from author where id = ?')).not.toBe(
      queryFamilyHash('select * from book where id = ?'),
    );
  });

  it('normalizes case of keywords but is deterministic and non-empty', () => {
    const hash = queryFamilyHash('SELECT * FROM author');
    expect(hash).toBe(queryFamilyHash('select * from author'));
    expect(hash.length).toBeGreaterThan(0);
  });

  it("masks string literals too", () => {
    expect(queryFamilyHash("select * from author where name = 'davi'")).toBe(
      queryFamilyHash("select * from author where name = 'maria'"),
    );
  });
});
