// packages/core/src/nest/async-static-options.ts
import { Logger } from '@nestjs/common';
import { DEFAULT_TELESCOPE_PATH, normalizeTelescopePath } from '../config/normalize-path.js';
import type { TelescopeModuleOptions } from './telescope.options.js';

/**
 * The options `forRootAsync` reads at module-build time, before any factory
 * runs: they decide which controllers exist, where, and with which
 * decorators. A factory can't change them.
 */
export const BUILD_TIME_OPTIONS = ['decorators', 'mcpDecorators', 'routes', 'imports'] as const;

/** What `forRootAsync` was given statically, next to `useFactory`. */
export type AsyncStaticOptions = Pick<
  TelescopeModuleOptions,
  'path' | (typeof BUILD_TIME_OPTIONS)[number]
>;

/**
 * Reconciles the options an async factory resolved with the static ones
 * `forRootAsync` built the module from:
 *
 * - A build-time option (`decorators`, `mcpDecorators`, `routes`, `imports`)
 *   returned by the factory has no effect: the routes were built without it.
 *   It is logged, since a guard that silently isn't there is easy to miss.
 * - `path` mounts the routes (static) AND tells the request capture and the UI
 *   where the console lives (resolved options). A static `path` is copied into
 *   the resolved options so both agree; a different one from the factory is
 *   logged and overridden. A factory `path` with no static one is kept, as
 *   before, and logged unless `routes: false` (the routes are then on the
 *   default `telescope` mount).
 */
export function withStaticOptions(
  resolved: TelescopeModuleOptions,
  statics: AsyncStaticOptions,
  logger: Pick<Logger, 'warn'> = new Logger('TelescopeModule'),
): TelescopeModuleOptions {
  const ignored = BUILD_TIME_OPTIONS.filter((key) => resolved[key] !== undefined);
  if (ignored.length > 0) {
    logger.warn(
      `forRootAsync: ${ignored.map((key) => `\`${key}\``).join(', ')} returned by useFactory ${
        ignored.length === 1 ? 'has' : 'have'
      } no effect: the routes are built before the factory runs. Pass ${
        ignored.length === 1 ? 'it' : 'them'
      } as static top-level options of forRootAsync, next to useFactory.`,
    );
  }

  if (resolved.path === undefined) {
    return statics.path === undefined ? resolved : { ...resolved, path: statics.path };
  }
  const factoryPath = normalizeTelescopePath(resolved.path);
  if (statics.path === undefined) {
    // With `routes: false` nothing is mounted here, so the factory's path is the mount.
    if (statics.routes !== false && factoryPath !== DEFAULT_TELESCOPE_PATH) {
      logger.warn(
        `forRootAsync: \`path: '${factoryPath}'\` returned by useFactory does not move the routes, which are mounted at '${DEFAULT_TELESCOPE_PATH}'. Pass \`path\` as a static top-level option of forRootAsync.`,
      );
    }
    return resolved;
  }
  const staticPath = normalizeTelescopePath(statics.path);
  if (factoryPath !== staticPath) {
    logger.warn(
      `forRootAsync: \`path: '${factoryPath}'\` returned by useFactory differs from the static \`path: '${staticPath}'\` the routes are mounted at; using '${staticPath}'.`,
    );
  }
  return { ...resolved, path: statics.path };
}
