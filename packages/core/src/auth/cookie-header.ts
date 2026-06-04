// packages/core/src/auth/cookie-header.ts

/**
 * Parse a raw `Cookie` request header into a name→value map. Dependency-free so
 * it works on raw Express AND Fastify requests without `cookie-parser`. Values
 * are URL-decoded; malformed segments are skipped, never thrown.
 */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (typeof header !== 'string' || header === '') return cookies;
  for (const segment of header.split(';')) {
    const eq = segment.indexOf('=');
    if (eq <= 0) continue;
    const name = segment.slice(0, eq).trim();
    if (name === '') continue;
    let rawValue = segment.slice(eq + 1).trim();
    // Strip a single pair of wrapping double-quotes (RFC 6265 quoted form).
    if (rawValue.length >= 2 && rawValue.startsWith('"') && rawValue.endsWith('"')) {
      rawValue = rawValue.slice(1, -1);
    }
    // First occurrence wins; don't clobber an earlier value with a later dup.
    if (name in cookies) continue;
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      cookies[name] = rawValue;
    }
  }
  return cookies;
}

export interface SetCookieOptions {
  path: string;
  /** Cookie lifetime in seconds. Ignored (and forced to 0) when `clear` is set. */
  maxAgeSeconds: number;
  /** Add `Secure` when the request is https. */
  secure: boolean;
  /** Clear the cookie: empty value + `Max-Age=0` (and `Expires` in the past). */
  clear?: boolean;
}

/**
 * Serialize a `Set-Cookie` header value. Always `HttpOnly` + `SameSite=Lax`
 * (Lax blocks cross-site POSTs carrying the cookie — CSRF coverage for the
 * dashboard's mutation POSTs). Platform-agnostic: just a string.
 */
export function serializeSetCookie(name: string, value: string, options: SetCookieOptions): string {
  const parts = [`${name}=${options.clear ? '' : encodeURIComponent(value)}`];
  parts.push(`Path=${options.path}`);
  parts.push('HttpOnly');
  parts.push('SameSite=Lax');
  if (options.secure) parts.push('Secure');
  if (options.clear) {
    parts.push('Max-Age=0');
    parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  } else {
    parts.push(`Max-Age=${options.maxAgeSeconds}`);
  }
  return parts.join('; ');
}
