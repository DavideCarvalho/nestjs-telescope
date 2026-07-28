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

interface EndableResponse {
  statusCode: number;
  headersSent?: boolean;
  setHeader(name: string, value: string | string[]): unknown;
  end(chunk?: string): unknown;
}

function isEndableResponse(value: unknown): value is EndableResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as EndableResponse).setHeader === 'function' &&
    typeof (value as EndableResponse).end === 'function'
  );
}

function resolveEndableResponse(response: unknown): EndableResponse | null {
  if (isEndableResponse(response)) return response;
  if (typeof response === 'object' && response !== null) {
    const raw = (response as { raw?: unknown }).raw;
    if (isEndableResponse(raw)) return raw;
  }
  return null;
}

/**
 * Did something already write to this response?
 *
 * Used to decide whether a host's `unauthenticatedPage` hook actually produced a page. A hook that
 * returns without writing (an early `return`, a forgotten `await`, a template that resolved to
 * nothing) would otherwise leave the request hanging forever — the browser spins until it times
 * out, with no error anywhere. Checking this lets the caller fall back to serving the SPA.
 */
export function responseAlreadyWritten(response: unknown): boolean {
  return resolveEndableResponse(response)?.headersSent === true;
}

/**
 * Write a full HTML page on the raw response and END it. Used by the dashboard's SPA shell route,
 * which is non-passthrough so a host's `unauthenticatedPage` can take the response over instead.
 */
export function sendHtml(response: unknown, status: number, html: string): void {
  const raw = resolveEndableResponse(response);
  if (!raw) return;
  raw.statusCode = status;
  raw.setHeader('content-type', 'text/html; charset=utf-8');
  // index.html references hash-named bundles, so it MUST NOT be cached (stale bundle = the classic
  // "stuck loading after a deploy"); the unauthenticated page likewise reflects live session state.
  raw.setHeader('cache-control', 'no-store, must-revalidate');
  raw.end(html);
}
