// packages/core/src/nest/telescope-mount-paths.ts
import { normalizeTelescopePath } from '../config/normalize-path.js';

/**
 * Route roots a host must EXCLUDE from a global prefix (`setGlobalPrefix`) so
 * the Telescope dashboard/API/assets keep resolving at their configured mount
 * path instead of being shifted under the prefix.
 *
 * `path` is normalized the same way `TelescopeModule.forRoot({ path })` /
 * `forRootAsync({ path })` normalize it (see {@link normalizeTelescopePath}),
 * so a leading/trailing slash or an unset `path` produces the same roots the
 * module actually mounts on.
 *
 * This covers ONLY the routes. Under a global prefix the request-capture
 * middleware ALSO needs `registerRequestMiddleware: false` plus a manual
 * `app.use(telescopeRequestCapture(app.get(TelescopeService)))` — see the
 * `registerRequestMiddleware` option doc on {@link TelescopeModuleOptions} for
 * why (NestJS scopes module middleware to the prefixed route table).
 *
 * @example
 * ```ts
 * app.setGlobalPrefix('api', { exclude: telescopeMountPaths() });
 * ```
 */
export function telescopeMountPaths(path = 'telescope'): string[] {
  const normalized = normalizeTelescopePath(path);
  return [normalized, `${normalized}/{*splat}`];
}
