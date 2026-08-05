// packages/core/src/nest/telescope.options.ts
import type { CanActivate, DynamicModule, Type } from '@nestjs/common';
import type { TelescopeAiOptions } from '../ai/diagnoser.js';
import type { AlertsOptions } from '../alerts/alert-rule.js';
import type { DashboardAuthOptions } from '../auth/dashboard-auth-config.js';
import type { TelescopeSessionUser } from '../auth/session-cookie.js';
import type { TelescopeCoreOptions } from '../config/options.js';
import type { TelescopeExtension } from '../extension/types.js';
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
 * The minimal structural request the telescope hooks receive — enough for
 * header/user checks without coupling to Express/Fastify types. A real Express
 * `Request` or Fastify `FastifyRequest` satisfies this shape, so a host can
 * pass its platform request straight through with no hand-rolled guard.
 */
export interface TelescopeHttpRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  /** Whatever upstream auth middleware attached; shape is the host app's. */
  user?: unknown;
  [key: string]: unknown;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown[]): value is string[] {
  return value.every((item) => typeof item === 'string');
}

/**
 * Narrows a raw platform request (typed `unknown` at the framework boundary,
 * e.g. `@Req() request: unknown`) into a {@link TelescopeHttpRequest} without an
 * unsafe cast. Every own-enumerable field passes through via the index
 * signature; `headers` entries that aren't `string | string[] | undefined` are
 * dropped rather than force-cast. A non-object input yields `{}`.
 */
export function toTelescopeHttpRequest(request: unknown): TelescopeHttpRequest {
  if (!isPlainRecord(request)) return {};
  const result: TelescopeHttpRequest = { ...request };
  const headers = request.headers;
  if (isPlainRecord(headers)) {
    const normalizedHeaders: Record<string, string | string[] | undefined> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === 'string' || value === undefined) {
        normalizedHeaders[key] = value;
      } else if (Array.isArray(value) && isStringArray(value)) {
        normalizedHeaders[key] = value;
      }
    }
    result.headers = normalizedHeaders;
  }
  return result;
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
  /**
   * Opt-in capture of process-level crashes (`unhandledRejection` /
   * `uncaughtException`) as `exception` entries. Off by default; see
   * {@link ProcessCrashCaptureOptions} for the exit contract, which you MUST
   * read before enabling — attaching these listeners changes whether your
   * process dies.
   */
  processCrashes?: ProcessCrashCaptureOptions;
}

/**
 * Opt-in capture of the failures that never reach the Nest pipeline: a promise
 * rejected with no handler, and a throw that escapes to the event loop (from a
 * timer, a stream callback, an event emitter). The exception interceptor only
 * sees errors thrown out of a route handler, so before this option those
 * failures produced nothing at all — no entry, no exception family, no
 * `new-exception` alert — and they are exactly the failures that take a process
 * down.
 *
 * ## Why this is opt-in
 *
 * Registering a `process.on('uncaughtException')` listener SUPPRESSES Node's
 * default fatal exit. A library that did that behind the host's back would
 * silently convert "crashed, restarted clean by the orchestrator" into "limping
 * along with half-initialised state" — worse than the blind spot it was fixing.
 * The same applies to `unhandledRejection` under Node's default
 * `--unhandled-rejections=throw`. So this is `enabled: false` until you say
 * otherwise, and Telescope reproduces the crash it suppressed.
 *
 * ## Keeping Node's original crash behaviour
 *
 * Leave `onCrash` at its `'auto'` default and register no competing handler:
 * Telescope sees zero pre-existing listeners, picks `'exit'`, and after
 * recording writes the stack to stderr and calls `process.exit(1)` — what Node
 * would have done. If you already have your own handler (or an APM agent's),
 * `'auto'` picks `'passthrough'` and leaves the exit decision entirely to it.
 */
export interface ProcessCrashCaptureOptions {
  /**
   * Master switch. Default `false` — no process listeners are registered and
   * crash semantics are untouched.
   */
  enabled: boolean;
  /**
   * What happens after the entry is recorded and the bounded flush settles.
   *
   * - `'exit'` — reproduce Node's default: stack to stderr, then
   *   `process.exit(exitCode)`.
   * - `'passthrough'` — record only and return; something else owns the exit.
   *   Setting this WITHOUT another handler that exits turns every crash into a
   *   zombie process.
   * - `'auto'` (default) — decided once at `onModuleInit` from the number of
   *   pre-existing `uncaughtException` + `unhandledRejection` listeners: zero ⇒
   *   `'exit'` (nothing else was deciding, Node would have crashed), otherwise
   *   `'passthrough'` (the host was already deciding, so don't yank the exit out
   *   from under it). The resolved mode is logged once at boot.
   *
   * Because `'auto'` samples at bootstrap, a host that registers its own
   * handler LATER must pass `onCrash` explicitly.
   */
  onCrash?: 'exit' | 'passthrough' | 'auto';
  /**
   * Budget in milliseconds for flushing the crash entry before the exit
   * contract is applied. Default `2000`. The flush is RACED against this on an
   * unref'd timer, never awaited unbounded: a wedged storage provider must delay
   * a dying process by at most a known amount, not hang it forever. Exceeding
   * the budget loses the entry — the right trade for a process that is leaving.
   */
  flushTimeoutMs?: number;
  /** Exit code used by `onCrash: 'exit'`. Default `1`, matching Node. */
  exitCode?: number;
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
  authorize?: (request: TelescopeHttpRequest) => boolean | Promise<boolean>;
}

/**
 * Tuning for the pre-record request-body capture gate (see
 * {@link TelescopeModuleOptions.requestCapture}).
 */
export interface RequestCaptureOptions {
  /**
   * Bodies larger than this are not captured — the request entry still records
   * method/path/status/duration, only `payload` becomes
   * `'[Skipped: N bytes > maxBodyBytes]'`. Size comes from the `content-length`
   * header when present; otherwise, for a string/Buffer body, its own length —
   * NEVER from `JSON.stringify`-ing a parsed body (that IS the synchronous walk
   * this gate exists to avoid), so a parsed object body without a
   * `content-length` header passes the size gate untouched. Default `131_072`
   * (128 KiB). Set `false` to disable the size gate entirely.
   *
   * This is the safe-by-default fix for event-loop stalls from giant bodies: the
   * gate runs in the middleware BEFORE `TelescopeService.record()`, so the
   * synchronous redaction walk never even sees a skipped body.
   */
  maxBodyBytes?: number | false;
  /**
   * Content types whose bodies are never captured — matched against the
   * request's `content-type` header. A `string` pattern matches as a
   * case-insensitive PREFIX (e.g. `'multipart/form-data'` matches
   * `'multipart/form-data; boundary=...'`); a `RegExp` is `.test()`-ed against
   * the raw header value. Payload becomes `'[Skipped: <content-type>]'`.
   * Default: `['application/offset+octet-stream', 'application/octet-stream',
   * 'multipart/form-data']` (binary/upload bodies).
   */
  skipBodyContentTypes?: (string | RegExp)[];
  /**
   * Skip body capture entirely for matching requests (e.g. an upload route) —
   * checked in addition to (not instead of) the content-type/size gates. The
   * request entry is still recorded (method/path/status/duration/user/headers);
   * only `payload` becomes `'[Skipped: skipBody predicate]'`. Runs synchronously
   * and is never awaited — return a plain `boolean`, not a `Promise`.
   */
  skipBody?: (request: TelescopeHttpRequest) => boolean;
}

export interface TelescopeModuleOptions extends TelescopeCoreOptions {
  /** Storage provider. Defaults to a SqliteStorageProvider(':memory:'). */
  storage?: StorageProvider;
  /** Watchers to register. Empty in the host plan. */
  watchers?: Watcher[];
  /** Extensions contributing watchers, entry types, dashboards, and data providers. */
  extensions?: TelescopeExtension[];
  /** Live-queue managers (e.g. BullMqQueueManager). Each contributes a driver to /queues/live.
   *  Watchers in `watchers` implementing the `QueueManager` SPI are auto-registered — this array is
   *  only needed for standalone managers (see the SPI doc in `queue/queue-manager.ts`). */
  queueManagers?: QueueManager[];
  /**
   * Schedule managers (e.g. the `@nestjs/schedule` watcher). Each contributes
   * registered cron/interval/timeout tasks to /schedules/live.
   *
   * Watchers in `watchers` that implement the `ScheduleManager` SPI are
   * auto-registered — this array is only needed for standalone managers (see
   * the SPI doc in `schedule/schedule-manager.ts`).
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
   * Pre-record capture gate for request bodies: size cap, content-type skip
   * list, and a route predicate — all evaluated in the middleware BEFORE
   * `TelescopeService.record()`, so a giant/binary body never reaches the
   * synchronous redaction walk. The request entry (method/path/status/duration/
   * user/headers) is always recorded; only `payload` is replaced by a marker
   * string when a gate trips. ON by default (128 KiB cap + a binary
   * content-type list) — this is the safe default, not an opt-in. See
   * {@link RequestCaptureOptions}.
   */
  requestCapture?: RequestCaptureOptions;
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
  /**
   * MCP (Model Context Protocol) server. When enabled, Telescope serves a
   * stateless JSON-RPC MCP endpoint at `POST <telescope>/api/mcp` so coding
   * agents (Claude Code, Cursor, …) can query the captured data directly —
   * "why is POST /checkout slow?" → the agent pulls the batch waterfall with
   * every query. Backed by the same storage/stats APIs as the dashboard.
   *
   * AUTH: when a `token` is configured, every MCP request MUST carry a
   * `Authorization: Bearer <token>` header (the MCP transport's auth model; the
   * cookie-session dashboard gate doesn't apply to a header-only agent client).
   * Without a token the endpoint is allowed ONLY when `NODE_ENV !== 'production'`
   * (mirroring the default-open-in-dev dashboard authorizer) — in production a
   * tokenless MCP config is refused (403) so the surface never opens unguarded.
   *
   * Pass `true` for the dev-only default, or `{ token }` to require a Bearer
   * token. DISABLED by default (`undefined`).
   */
  mcp?: boolean | { token?: string };
  /**
   * Overhead guard / overload protection. Telescope watches the event-loop lag
   * (via `perf_hooks.monitorEventLoopDelay`) and, when the p99 lag crosses a
   * threshold, PAUSES capture (the Recorder drops new `record()` calls) until
   * the lag recovers — so a telescope under load can never amplify an incident.
   *
   * Pass `true` (the default) for the 200ms threshold, `false` to disable, or
   * `{ maxEventLoopLagMs }` to tune it. ON by default at 200ms.
   *
   * `startupGraceMs` (default ~5000) is a window after the guard arms during
   * which it samples but never pauses/logs — so the synchronous bootstrap stall
   * (DI wiring, migrations, codegen blocking the event loop) can't trip the guard
   * on a transient. Set `0` to arm immediately. Ignored when protection is off.
   */
  overloadProtection?: boolean | { maxEventLoopLagMs?: number; startupGraceMs?: number };
  /**
   * Guard classes (or already-instantiated `CanActivate`s) fronting the console's
   * API controllers — `TelescopeController` (entries/metrics/traces/ext data
   * providers/retention/…) and `StreamController`'s live SSE feed. Stamped
   * ALONGSIDE Telescope's own built-in gate (`TelescopeGuard`'s `authorizer` /
   * `dashboardAuth` / dev-open-prod-closed default) — APPEND, not replace: a
   * request must pass the built-in gate AND every guard listed here.
   *
   * This is deliberate and differs from a from-scratch dashboard: Telescope's
   * console controllers already ship a default-deny-in-production gate, so
   * `guards` is an ADDITIONAL seam for hosts that want to front the console with
   * THEIR OWN auth — e.g. reusing the app's existing cookie-session guard —
   * instead of (or in addition to) configuring `dashboardAuth`'s own
   * login/session bridge. See the "Securing the console" guide.
   *
   * IMPORTANT: pass the SAME `guards` (and matching `imports`) to
   * `TelescopeUiModule.forRoot({ guards, imports })` too — the dashboard's page
   * (HTML shell + hashed assets) lives in a SEPARATE package/module with no
   * visibility into this option, so a `guards` set here alone still leaves the
   * page itself reachable by an anonymous full-page navigation.
   *
   * A class guard's own DEPENDENCIES resolve from this module's `imports` (see
   * {@link imports}) — `TelescopeModule` has no application context of its own
   * to pull them from otherwise. An already-instantiated guard (a `CanActivate`
   * object, not a class) needs no `imports` entry.
   */
  guards?: Array<Type<CanActivate> | CanActivate>;
  /**
   * Extra `imports` merged into `TelescopeModule`'s own dynamic module — the DI
   * resolution path for a class passed to {@link guards} (or any other provider
   * the console controllers need reachable). Typically the host's own auth
   * module, e.g. `imports: [AuthModule]` alongside `guards: [ConsoleAuthGuard]`.
   */
  imports?: DynamicModule['imports'];
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
/** Resolved ExtensionRegistry (built + boot-validated from options.extensions). */
export const TELESCOPE_EXTENSIONS = Symbol('TELESCOPE_EXTENSIONS');
