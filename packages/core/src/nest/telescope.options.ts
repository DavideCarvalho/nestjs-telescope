// packages/core/src/nest/telescope.options.ts
import type { TelescopeAiOptions } from '../ai/diagnoser.js';
import type { AlertsOptions } from '../alerts/alert-rule.js';
import type { DashboardAuthOptions } from '../auth/dashboard-auth-config.js';
import type { TelescopeSessionUser } from '../auth/session-cookie.js';
import type { TelescopeCoreOptions } from '../config/options.js';
import type { PulseServiceOptions } from '../pulse/pulse.service.js';
import type { QueueActionRequest, QueueManager } from '../queue/queue-manager.js';
import type { ScheduleManager } from '../schedule/schedule-manager.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import type { Watcher } from './watcher.js';

/** Context handed to the authorizer to decide API/UI access. */
export interface AuthorizerContext {
  /** The platform request object (Express or Fastify). */
  request: unknown;
}

/**
 * Tuning for how thrown server-side exceptions become `exception` entries.
 *
 * WHY this exists: by default Telescope does NOT record a NestJS `HttpException`
 * whose status is a 4xx (`>= 400 && < 500`) as an exception entry. A 403
 * (Forbidden), 404 (NotFound) or a validation 400 is expected control flow —
 * the framework doing its job — not an incident. Recording each one as an
 * exception opens a NEW exception family (the family hash keys on
 * name+message+top-frame, so each call site is distinct), fires the
 * `new-exception` Slack alert, and in AI auto-mode spends model tokens
 * diagnosing intended behaviour. In production every permission denial would
 * page on-call and burn a diagnosis. (This default changed after exactly that
 * incident: Telescope's own client-errors `authorize` gate threw a 403, which
 * was captured as a brand-new family and paged Slack.)
 *
 * The 4xx is NOT lost — the request-capture middleware still records the 4xx
 * `statusCode` on its own `request` entry; only the exception family is skipped.
 *
 * 5xx HttpExceptions and non-`HttpException` errors are ALWAYS recorded.
 */
export interface ExceptionsOptions {
  /**
   * When `true`, restore the pre-change behaviour: 4xx `HttpException`s are
   * captured as exception entries again (and so can group, alert, and be
   * diagnosed). Default `false` — 4xx control flow is skipped. Set this only if
   * your host genuinely treats 4xx as exceptions worth grouping/alerting on.
   */
  captureHttp4xx?: boolean;
}

/**
 * Public front-end error ingestion (`POST <telescope>/api/client-errors`). When
 * enabled, browsers report errors directly to Telescope, which records them as
 * `client_exception` entries through the normal pipeline (family-hash,
 * `failed`/`client`/`user:<id>` tags, alerts, prune, archive, dashboard).
 *
 * DISABLED by default: a public, unauthenticated ingestion surface is opt-in.
 * While disabled the controller is mounted but returns 404 for every request, so
 * the route never silently accepts traffic and toggling needs no remount.
 *
 * Security knobs, all best-effort and PER-POD (see the multi-replica caveat on
 * `rateLimit`): a byte cap (`maxBodyBytes`), an in-memory per-IP token bucket
 * (`rateLimit`), and an `authorize` hook for session/header validation.
 */
export interface ClientErrorsOptions {
  /** Master switch. Default `false` — the endpoint 404s until explicitly enabled. */
  enabled: boolean;
  /**
   * Hard cap on the accepted request body size in bytes. A larger body is
   * rejected (413) BEFORE structural validation, so a hostile browser can't make
   * Telescope parse a huge payload. Default `32_768` (32 KB).
   */
  maxBodyBytes?: number;
  /**
   * Per-IP token-bucket rate limit. `perMinute` requests are allowed per IP per
   * minute (default `60`); over the limit returns 429. The bucket map is bounded
   * and per-pod (in-memory), so in a multi-replica deployment the EFFECTIVE limit
   * is `perMinute × pods` and a client pinned to one pod sees exactly `perMinute`
   * — acceptable for abuse-dampening, not a hard quota. A shared limiter would
   * need a cross-pod store and is out of scope here.
   */
  rateLimit?: { perMinute: number };
  /**
   * Optional gate that runs FIRST, before validation/rate-limiting. Return
   * `false` to reject with 403 — lets a host require a session cookie or a shared
   * header on the public endpoint. A throw is treated as a denial (fail closed)
   * and never crashes the request.
   */
  authorize?: (request: unknown) => boolean | Promise<boolean>;
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
   * Pluggable-channel alerting. When set, Telescope evaluates `rules` and fans
   * each fired alert out to every configured `channels` entry (Slack / raw
   * webhook / custom sink) concurrently; one channel failing never blocks the
   * others. The legacy single `webhookUrl` is still accepted and folded into the
   * channels. A configured `alerts` with NO destination or empty `rules` is a
   * fail-closed boot error. See {@link AlertsOptions}.
   */
  alerts?: AlertsOptions;
  /**
   * Tuning for the Pulse health snapshot (`/api/pulse` + the Overview). Most
   * hosts never set this. The notable knob is `slowRouteMs`: the p99 (ms) a
   * route must reach to count as a "Slow request hotspot" (default 1000, matching
   * the `slow` request-tag threshold). Without it, hotspots are a pure top-N p99
   * ranking, so a quiet host surfaces fast routes (e.g. `/health`) as false
   * alarms. See {@link PulseServiceOptions}.
   */
  pulse?: PulseServiceOptions;
  /**
   * Public front-end error ingestion. When `enabled`, browsers can POST errors
   * to `<telescope>/api/client-errors` and they are recorded as `client_exception`
   * entries. DISABLED by default. See {@link ClientErrorsOptions}.
   */
  clientErrors?: ClientErrorsOptions;
  /**
   * AI-powered exception diagnosis. Supply a `diagnoser` (e.g.
   * `createAiSdkDiagnoser` from `@dudousxd/nestjs-telescope-ai`) and the dashboard
   * exposes a "Diagnose with AI" button on exception detail pages
   * (`POST <telescope>/api/exceptions/:id/diagnose`). In `mode: 'auto'`, a NEW
   * exception family is ALSO diagnosed fire-and-forget on the flush path and the
   * result is attached to a firing `new-exception` alert when ready. The SHAPE is
   * defined in core so core carries no AI dependency. See {@link TelescopeAiOptions}.
   */
  ai?: TelescopeAiOptions;
  /**
   * How thrown server-side exceptions become `exception` entries. The notable
   * knob is `captureHttp4xx`: by default 4xx `HttpException`s (Forbidden /
   * NotFound / validation 400) are treated as control flow and NOT recorded as
   * exceptions, so they never open a family, fire `new-exception`, or trigger AI
   * diagnosis. See {@link ExceptionsOptions}.
   */
  exceptions?: ExceptionsOptions;
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
