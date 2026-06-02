// packages/core/src/nest/platform-request.ts

export interface NormalizedRequest {
  method: string;
  url: string;
  headers: Record<string, unknown>;
  ip: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** Normalize a raw Node request (Express or Fastify-via-middie) into recordable fields. */
export function normalizeRequest(req: unknown): NormalizedRequest {
  const record = asRecord(req);
  const socket = asRecord(record.socket);
  const url = record.originalUrl !== undefined ? record.originalUrl : record.url;
  const ipCandidate = record.ip !== undefined ? record.ip : socket.remoteAddress;
  return {
    method: asString(record.method, 'UNKNOWN'),
    url: asString(url, ''),
    headers: asRecord(record.headers),
    ip: typeof ipCandidate === 'string' ? ipCandidate : null,
  };
}
