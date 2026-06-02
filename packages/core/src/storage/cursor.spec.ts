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
});
