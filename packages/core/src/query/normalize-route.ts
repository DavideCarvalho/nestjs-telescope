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
