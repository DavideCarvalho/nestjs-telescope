// packages/core/src/storage/cursor.ts

/**
 * Opaque keyset pagination cursor over (createdAt-epoch-ms, id). Every bundled storage provider
 * pages entries with this codec, and the console's `GET entries` rejects (400) a cursor it cannot
 * decode, so a custom provider must make its `nextCursor` with {@link encodeCursor} too.
 */
export function encodeCursor(createdAtMs: number, id: string): string {
  return Buffer.from(`${createdAtMs}:${id}`).toString('base64url');
}

/**
 * The (createdAt, id) position of a cursor made by {@link encodeCursor}, or `null` when the
 * string is not one: only the exact encoding of an integer epoch-ms and a non-empty id decodes,
 * so junk that happens to be valid base64url is not mistaken for a position.
 */
export function decodeCursor(cursor: string): { createdAt: number; id: string } | null {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep <= 0) return null;
  const createdAt = Number(decoded.slice(0, sep));
  const id = decoded.slice(sep + 1);
  if (!Number.isSafeInteger(createdAt) || id === '') return null;
  if (encodeCursor(createdAt, id) !== cursor) return null;
  return { createdAt, id };
}
