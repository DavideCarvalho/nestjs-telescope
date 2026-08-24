/**
 * Telescope's `normalizeRoute` lives in its query internals and is not
 * re-exported from `@dudousxd/nestjs-telescope`'s entrypoint, so the rule it
 * encodes is restated here rather than reaching into the package's file layout.
 *
 * Observe groups every snapshot by `op`, so an id-like segment MUST collapse:
 * one operation per route, not one per order id.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALL_DIGITS_PATTERN = /^\d+$/;
const LONG_HEX_PATTERN = /^[0-9a-f]{16,}$/i;

function isIdSegment(segment: string): boolean {
  return (
    UUID_PATTERN.test(segment) || ALL_DIGITS_PATTERN.test(segment) || LONG_HEX_PATTERN.test(segment)
  );
}

/**
 * `"GET /orders/:id"` for a method + url. The query string is dropped: it is
 * both unbounded in cardinality and the most likely place for a secret.
 */
export function operationId(method: string | undefined, url: string): string {
  const queryStart = url.indexOf('?');
  const path = queryStart === -1 ? url : url.slice(0, queryStart);
  const normalizedPath = path
    .split('/')
    .map((segment) => (isIdSegment(segment) ? ':id' : segment))
    .join('/');
  return method === undefined || method === '' ? normalizedPath : `${method} ${normalizedPath}`;
}
