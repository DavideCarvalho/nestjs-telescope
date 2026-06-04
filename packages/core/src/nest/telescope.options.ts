// packages/core/src/nest/telescope.options.ts
import type { TelescopeCoreOptions } from '../config/options.js';
import type { QueueActionRequest, QueueManager } from '../queue/queue-manager.js';
import type { ScheduleManager } from '../schedule/schedule-manager.js';
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
  /** Live-queue managers (e.g. BullMqQueueManager). Each contributes a driver to /queues/live. */
  queueManagers?: QueueManager[];
  /**
   * Schedule managers (e.g. the `@nestjs/schedule` watcher). Each contributes
   * registered cron/interval/timeout tasks to /schedules/live.
   */
  scheduleManagers?: ScheduleManager[];
  /**
   * Authorizes API access. Default: allow when NODE_ENV !== 'production',
   * deny otherwise (until the host supplies one).
   */
  authorizer?: (ctx: AuthorizerContext) => boolean | Promise<boolean>;
  /**
   * Authorizes a queue MUTATION (retry/remove/promote/retry-all/redrive).
   * Separate from `authorizer` (reads). DEFAULT: deny — every mutation is 403
   * until the host supplies this. Throwing denies (fails closed).
   */
  authorizeAction?: (
    ctx: AuthorizerContext,
    action: QueueActionRequest,
  ) => boolean | Promise<boolean>;
  /**
   * Whether TelescopeModule auto-registers the request-capture middleware via
   * NestJS `configure()`. Default `true`. Set `false` when the host app uses
   * `setGlobalPrefix(...)`: NestJS scopes module middleware to the prefixed
   * route table, so the catch-all only captures `/`. In that case register the
   * capture globally in bootstrap instead —
   * `app.use(telescopeRequestCapture(app.get(TelescopeService)))`.
   */
  registerRequestMiddleware?: boolean;
}

export interface TelescopeOptionsFactory {
  createTelescopeOptions(): Promise<TelescopeModuleOptions> | TelescopeModuleOptions;
}

export const TELESCOPE_OPTIONS = Symbol('TELESCOPE_OPTIONS');
export const TELESCOPE_STORAGE = Symbol('TELESCOPE_STORAGE');
export const TELESCOPE_CONFIG = Symbol('TELESCOPE_CONFIG');
/** Kept for future DI use; the registry reads `options.queueManagers` directly. */
export const QUEUE_MANAGERS = Symbol('QUEUE_MANAGERS');
