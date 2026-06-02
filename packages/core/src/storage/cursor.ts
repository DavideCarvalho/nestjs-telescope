// packages/core/src/storage/cursor.ts

/** Opaque keyset pagination cursor over (createdAt-epoch-ms, id). */
export function encodeCursor(createdAtMs: number, id: string): string {
  return Buffer.from(`${createdAtMs}:${id}`).toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: number; id: string } | null {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep === -1) return null;
  const createdAt = Number(decoded.slice(0, sep));
  if (Number.isNaN(createdAt)) return null;
  return { createdAt, id: decoded.slice(sep + 1) };
}
