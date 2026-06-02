// packages/core/src/nest/telescope.options.ts
import type { TelescopeCoreOptions } from '../config/options.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import type { Watcher } from './watcher.js';

/** Context handed to the authorizer to decide API/UI access. */
export interface AuthorizerContext {
  /** The platform request object (Express or Fastify). */
  request: unknown;
}

export interface TelescopeModuleOptions extends TelescopeCoreOptions {
  /** Storage provider. Defaults to a SqliteStorageProvider(':memory:'). */
  storage?: StorageProvider;
  /** Watchers to register. Empty in the host plan. */
  watchers?: Watcher[];
  /**
   * Authorizes API access. Default: allow when NODE_ENV !== 'production',
   * deny otherwise (until the host supplies one).
   */
  authorizer?: (ctx: AuthorizerContext) => boolean | Promise<boolean>;
}

export interface TelescopeOptionsFactory {
  createTelescopeOptions(): Promise<TelescopeModuleOptions> | TelescopeModuleOptions;
}

export const TELESCOPE_OPTIONS = Symbol('TELESCOPE_OPTIONS');
export const TELESCOPE_STORAGE = Symbol('TELESCOPE_STORAGE');
export const TELESCOPE_CONFIG = Symbol('TELESCOPE_CONFIG');
