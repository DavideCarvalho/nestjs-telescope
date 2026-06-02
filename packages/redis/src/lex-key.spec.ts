import { describe, expect, it } from 'vitest';
import { idFromMember, invBound, lexMember } from './lex-key.js';

describe('lex-key codec', () => {
  it('orders newest-first: a newer createdAt yields a lexicographically smaller member', () => {
    const older = lexMember(1000, 'a');
    const newer = lexMember(2000, 'a');
    expect(newer < older).toBe(true);
  });

  it('ties on createdAt order by id ascending within the same timestamp', () => {
    const a = lexMember(1000, 'aaa');
    const b = lexMember(1000, 'bbb');
    expect(a < b).toBe(true);
  });

  it('round-trips the id out of a member', () => {
    expect(idFromMember(lexMember(1234, 'some:weird:id'))).toBe('some:weird:id');
  });

  it('invBound is monotonic: newer createdAt -> smaller bound', () => {
    expect(invBound(2000) < invBound(1000)).toBe(true);
  });

  it('lexMember starts with invBound(createdAt) so range bounds line up', () => {
    expect(lexMember(1500, 'x').startsWith(invBound(1500))).toBe(true);
  });
});
