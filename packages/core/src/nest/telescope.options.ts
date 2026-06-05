// packages/core/src/nest/telescope.options.ts
import type { AlertsOptions } from '../alerts/alert-rule.js';
import type { DashboardAuthOptions } from '../auth/dashboard-auth-config.js';
import type { TelescopeSessionUser } from '../auth/session-cookie.js';
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
  /**
   * Resolves the "authenticated user" recorded on a request entry from the raw
   * platform request. Defaults to reading `request.user` (the common
   * Passport/guard convention). Return `null`/`undefined` for anonymous. The
   * resolved value is redacted by the Recorder like any other content.
   */
  resolveUser?: (request: unknown) => unknown;
  /**
   * Host-provided hook that runs an engine `EXPLAIN` for a captured query and
   * returns the plan. Telescope is DB-agnostic, so the HOST brings its own
   * connection/dialect — Telescope only hands over the captured SQL and bindings
   * exactly as recorded. When unset, the explain endpoint reports 404 (feature
   * off) and `meta.explainEnabled` is `false`.
   *
   * The hook runs ARBITRARY SQL `EXPLAIN` against your database, so scope its
   * connection read-only (and to non-sensitive schemas) — a captured statement
   * is replayed as `EXPLAIN <sql>`. Throwing surfaces as a clean `{ message }`
   * error to the dashboard (the plan failed to run), not a crash.
   *
   * @example MySQL (mysql2):
   * ```ts
   * explainQuery: async (sql, bindings) => {
   *   const [rows] = await pool.query(`EXPLAIN FORMAT=JSON ${sql}`, bindings);
   *   return rows;
   * }
   * ```
   */
  explainQuery?: (sql: string, bindings: unknown[]) => Promise<unknown>;
  /**
   * Cookie-session gate for the dashboard. When set, every guarded `/api/*`
   * route (except `/api/auth/*`) requires a valid signed session cookie, AND
   * the existing `authorizer` still runs (AND semantics). The cookie is minted
   * by either mode (`session` host-auth bridge / built-in `login`). When unset,
   * gate behavior is unchanged (`authorizer` / NODE_ENV default). A configured
   * `dashboardAuth` with a missing/empty `secret` or no hook is a boot error.
   */
  dashboardAuth?: DashboardAuthOptions;
  /**
   * Webhook-only alerting (v1). When set, Telescope evaluates `rules` on an
   * unref'd interval and POSTs a JSON payload to `webhookUrl` when a rule fires
   * (per-rule cooldown applies). A configured `alerts` with an empty
   * `webhookUrl` or empty `rules` is a fail-closed boot error. See
   * {@link AlertsOptions}.
   */
  alerts?: AlertsOptions;
}

export interface TelescopeOptionsFactory {
  createTelescopeOptions(): Promise<TelescopeModuleOptions> | TelescopeModuleOptions;
}

export const TELESCOPE_OPTIONS = Symbol('TELESCOPE_OPTIONS');
export const TELESCOPE_STORAGE = Symbol('TELESCOPE_STORAGE');
export const TELESCOPE_CONFIG = Symbol('TELESCOPE_CONFIG');
/** Resolved `dashboardAuth` config (or `null` when unconfigured). Boot-validated. */
export const TELESCOPE_DASHBOARD_AUTH = Symbol('TELESCOPE_DASHBOARD_AUTH');
/** Kept for future DI use; the registry reads `options.queueManagers` directly. */
export const QUEUE_MANAGERS = Symbol('QUEUE_MANAGERS');
