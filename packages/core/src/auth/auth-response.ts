// packages/core/src/auth/auth-response.ts

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface RawNodeResponse {
  getHeader(name: string): number | string | string[] | undefined;
  setHeader(name: string, value: string | string[]): unknown;
}

function isRawNodeResponse(value: unknown): value is RawNodeResponse {
  return (
    isRecord(value) &&
    typeof value.getHeader === 'function' &&
    typeof value.setHeader === 'function'
  );
}

/**
 * Resolve the writable Node `ServerResponse` from a platform response. Express'
 * response IS the Node response; Fastify's reply wraps it on `.raw`. Returns the
 * outer response when it already exposes get/setHeader (Express), otherwise the
 * unwrapped `.raw` (Fastify) — so a single `setHeader` path serves both.
 */
function resolveRawResponse(response: unknown): RawNodeResponse | null {
  if (isRawNodeResponse(response)) return response;
  if (isRecord(response) && isRawNodeResponse(response.raw)) return response.raw;
  return null;
}

function existingSetCookies(response: RawNodeResponse): string[] {
  const current = response.getHeader('set-cookie');
  if (Array.isArray(current)) return current;
  if (typeof current === 'string') return [current];
  return [];
}

/**
 * Append a `Set-Cookie` header to the response WITHOUT clobbering any cookies
 * already queued by the host (auth or otherwise). Platform-agnostic raw write —
 * no-ops gracefully if the response can't be unwrapped.
 */
export function appendSetCookie(response: unknown, cookie: string): void {
  const raw = resolveRawResponse(response);
  if (!raw) return;
  raw.setHeader('set-cookie', [...existingSetCookies(raw), cookie]);
}
