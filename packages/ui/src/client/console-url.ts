/**
 * Where the console SPA is served, for a link from YOUR app (e.g. an admin
 * page's "Open Telescope" anchor).
 *
 * Telescope's mount is configured as `path` (no leading slash, e.g. `'telescope'`); this accepts either
 * form and normalizes it. Access is whatever your `decorators` (or your own controllers) decide:
 * a plain navigation carries your app's cookies, so a cookie-session authentication strategy covers it.
 */

/** The mount default; matches `TelescopeUiModule.forRoot()`'s own default. */
const DEFAULT_BASE_PATH = '/telescope';

function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.trim().replace(/\/+$/, '');
  if (trimmed === '') return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/** Where the console SPA itself is served. */
export function telescopeConsoleUrl(basePath: string = DEFAULT_BASE_PATH): string {
  return normalizeBasePath(basePath) || '/';
}
