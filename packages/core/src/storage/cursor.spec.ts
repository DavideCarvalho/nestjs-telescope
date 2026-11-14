// packages/core/src/storage/cursor.spec.ts
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './cursor.js';

describe('cursor codec', () => {
  it('round-trips encode → decode', () => {
    const createdAtMs = 1_700_000_000_000;
    const id = 'entry-abc-123';
    const encoded = encodeCursor(createdAtMs, id);
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual({ createdAt: createdAtMs, id });
  });

  it('returns null for an undecodable string', () => {
    expect(decodeCursor('not-a-cursor')).toBeNull();
  });

  it('returns null for a colon-less base64url string', () => {
    // base64url-encode a string with no colon
    const noColon = Buffer.from('justtext').toString('base64url');
    expect(decodeCursor(noColon)).toBeNull();
  });

  it.each([
    ['garbage'],
    [''],
    [Buffer.from('abc:def').toString('base64url')],
    [Buffer.from('1.5:id').toString('base64url')],
    [Buffer.from(':id').toString('base64url')],
    [Buffer.from('17:').toString('base64url')],
    // the encoding of a valid cursor, padded: not what encodeCursor makes
    [`${Buffer.from('17:id').toString('base64url')}=`],
  ])('returns null for the non-cursor %j', (cursor) => {
    expect(decodeCursor(cursor)).toBeNull();
  });

  it('keeps an id that holds colons', () => {
    expect(decodeCursor(encodeCursor(17, 'a:b:c'))).toEqual({ createdAt: 17, id: 'a:b:c' });
  });
});
