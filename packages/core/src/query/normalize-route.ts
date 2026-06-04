// packages/core/src/query/normalize-route.ts

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALL_DIGITS_PATTERN = /^\d+$/;
const LONG_HEX_PATTERN = /^[0-9a-f]{16,}$/i;

/** A path segment is an id when it is a UUID, all digits, or a long hex string. */
function isIdSegment(segment: string): boolean {
  return (
    UUID_PATTERN.test(segment) || ALL_DIGITS_PATTERN.test(segment) || LONG_HEX_PATTERN.test(segment)
  );
}

/**
 * Build a stable route family from a request method + url, suitable as both a
 * `familyHash` group key and a human label. Strips the query string, then
 * replaces id-like segments (UUID / all-digits / long hex) with `:id`.
 *
 * @example
 *   normalizeRoute('GET', '/api/base/3c07e056-08bf-4dcb-ae21-9d426fb204df/mel/focus/123')
 *   // => 'GET /api/base/:id/mel/focus/:id'
 */
export function normalizeRoute(method: string, url: string): string {
  const queryStart = url.indexOf('?');
  const path = queryStart === -1 ? url : url.slice(0, queryStart);
  const normalizedPath = path
    .split('/')
    .map((segment) => (isIdSegment(segment) ? ':id' : segment))
    .join('/');
  return `${method} ${normalizedPath}`;
}

/**
 * Build a stable family for an OUTGOING HTTP call from a method + (possibly
 * absolute) url. Keeps the host and normalizes the path's id-like segments, so
 * calls to the same external endpoint group together regardless of ids:
 *
 * @example
 *   normalizeHttpTarget('GET', 'https://api.stripe.com/v1/charges/ch_123?foo=1')
 *   // => 'GET api.stripe.com/v1/charges/:id'
 *
 * Falls back to {@link normalizeRoute} over the raw url when it can't be parsed
 * as absolute (e.g. a relative target), so a family is always produced.
 */
export function normalizeHttpTarget(method: string, url: string): string {
  let host = '';
  let path = url;
  try {
    const parsed = new URL(url);
    host = parsed.host;
    path = parsed.pathname;
  } catch {
    return normalizeRoute(method, url);
  }
  const normalizedPath = path
    .split('/')
    .map((segment) => (isIdSegment(segment) ? ':id' : segment))
    .join('/');
  return `${method} ${host}${normalizedPath}`;
}
