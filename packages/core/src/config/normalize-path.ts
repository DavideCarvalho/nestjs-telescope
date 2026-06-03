// packages/core/src/config/normalize-path.ts

/** The default mount segment when no `path` option is supplied. */
export const DEFAULT_TELESCOPE_PATH = 'telescope';

/**
 * Normalizes a raw `path` option into a clean URL segment with no leading or
 * trailing slashes. `'/observability/'` -> `'observability'`. Empty / undefined
 * input (or input that is only slashes/whitespace) falls back to the default
 * `'telescope'`, so the mount path is byte-identical to today when unset.
 */
export function normalizeTelescopePath(path?: string): string {
  if (path === undefined) return DEFAULT_TELESCOPE_PATH;
  const trimmed = path.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed === '' ? DEFAULT_TELESCOPE_PATH : trimmed;
}
