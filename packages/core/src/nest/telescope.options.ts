// packages/core/src/nest/telescope.options.ts
import type { DynamicModule } from '@nestjs/common';
import type { TelescopeAiOptions } from '../ai/diagnoser.js';
import type { AlertsOptions } from '../alerts/alert-rule.js';
import type { TelescopeCoreOptions } from '../config/options.js';
import type { TelescopeExtension } from '../extension/types.js';
import type { PulseServiceOptions } from '../pulse/pulse.service.js';
import type { QueueManager } from '../queue/queue-manager.js';
import type { ScheduleManager } from '../schedule/schedule-manager.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import type { ConsoleAuthorize } from './console-authorize.js';
import type { Watcher } from './watcher.js';

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
 * incident: a 403 thrown by a gate on the client-errors route, which
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
 * DISABLED by default: a public ingestion surface is opt-in. While disabled the
 * controller is mounted but returns 404 for every request, so the route never
 * silently accepts traffic and toggling needs no remount.
 *
 * PUBLIC BY DESIGN: any visitor's browser (signed in or not) must reach it, so
 * it does NOT take the module's `decorators` or `authorize`; it carries only
 * the `@Can.Anyone()` mark. Its
 * abuse dampers, all best-effort and PER-POD (see the multi-replica caveat on
 * `rateLimit`), are a byte cap (`maxBodyBytes`) and an in-memory per-IP token
 * bucket (`rateLimit`). To put it behind your own auth, use `routes: false` and
 * extend `ClientErrorController` with your decorators.
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

/** See {@link TelescopeModuleOptions.aiMetrics}. */
export interface TelescopeAiMetricsOptions {
  /** Serve `GET <path>/api/metrics` (Prometheus text format). Default `false`. */
  prometheus?: boolean;
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
   * Enables the console's mutations: queue job retry/remove/promote/retry-all/
   * enqueue/redrive, prune, request replay and on-demand profiling. Default
   * `false`: every mutation answers 403 and `meta.mutationsEnabled` is `false`.
   *
   * This is a feature switch, not access control: who may call the routes is
   * decided by {@link authorize} (or your own controllers with `routes: false`),
   * exactly as for the read routes. To allow reads to more people than
   * mutations, mount the routes yourself and put a stricter `@Can(...)` on the
   * mutation methods you override.
   */
  mutations?: boolean;
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
   * AI-usage and agent-run metrics (`aviary_ai_*`, `aviary_agent_*`), read straight from the
   * `aviary:agent:*` diagnostics channels `@dudousxd/nestjs-agent` publishes (core >= 0.60.0).
   *
   * `prometheus: true` serves them as a Prometheus text scrape at `GET <path>/api/metrics`,
   * protected like the rest of the API (your `authorize`, or your own controller). Off by
   * default: the endpoint answers 404 and nothing subscribes. For OTLP push instead (or as well),
   * register `TelescopeAiMetricsExporter` from `@dudousxd/nestjs-telescope-otel`.
   *
   * The dashboard's AI screen does not need this — it reads recorded agent entries.
   */
  aiMetrics?: TelescopeAiMetricsOptions;
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
   * Protected like every other console route: by {@link authorize}, by
   * {@link mcpAuthorize} when the agent signs in differently from the
   * dashboard, or by your own controller with `routes: false`. Agent clients
   * send a header, not a cookie, so the usual check is a Bearer token:
   * `mcpAuthorize: authorizeByToken({ token: process.env.TELESCOPE_MCP_TOKEN })`.
   *
   * Pass `true` to enable. DISABLED by default (`undefined`): the handler
   * answers 404. The route is still mounted, so access is checked first: a
   * caller it refuses gets 401/403, and only a caller it lets through sees
   * the 404.
   */
  mcp?: boolean;
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
   * Who may use the console routes this module mounts: the API
   * (`TelescopeController`), the live feed (`StreamController`) and the MCP
   * endpoint (`TelescopeMcpController`, unless {@link mcpAuthorize} is set).
   * Runs after the app's authentication and your {@link decorators}, so
   * `request.user` is set. One of:
   *
   * ```ts
   * authorize: (ctx) => ctx.switchToHttp().getRequest().user?.isAdmin === true,
   * authorize: ConsoleAccess,                              // @Injectable() implements ConsoleAuthorizer
   * authorize: () => import('./console-access.js'),        // lazy, default export
   * authorize: { policy: ConsolePolicy, ability: 'view' }, // @nestjs/authorization policy
   * authorize: 'console.telescope',                        // gate name (@dudousxd/nestjs-authz)
   * authorize: authorizeByToken({ token: process.env.CONSOLE_TOKEN }),
   * ```
   *
   * The check returns `true`/`false`, `{ allowed }`, `{ allowed: false,
   * reason: 'unauthenticated' }` (401) or `{ redirectTo }` (401 with
   * `redirectTo` for API calls; the dashboard follows it). A throw denies.
   *
   * Omitted: open outside production; with `NODE_ENV === 'production'` every
   * request answers 403, and one warning is logged at boot.
   *
   * With `forRootAsync` it can come from the factory. The UI page is a
   * separate module: pass the same `authorize` to `TelescopeUiModule.forRoot`.
   */
  authorize?: ConsoleAuthorize;
  /**
   * Who may call the MCP endpoint (`POST <path>/api/mcp`). When set, it
   * REPLACES {@link authorize} on that route only; leave it out and the MCP
   * route follows `authorize`. Coding agents send a header, not a cookie:
   *
   * ```ts
   * TelescopeModule.forRoot({
   *   mcp: true,
   *   authorize: { policy: ConsolePolicy, ability: 'view' },
   *   mcpAuthorize: authorizeByToken({ token: process.env.TELESCOPE_MCP_TOKEN }),
   * })
   * ```
   */
  mcpAuthorize?: ConsoleAuthorize;
  /**
   * Class decorators applied to the console controllers this module mounts —
   * the API (`TelescopeController`), the live feed (`StreamController`) and the
   * MCP endpoint (`TelescopeMcpController`) — the same shape as `@nestjs/mcp`'s
   * `decorators`, for authentication, throttling and the like:
   *
   * ```ts
   * TelescopeModule.forRoot({
   *   decorators: [UseGuards(AuthenticationGuard)],
   *   authorize: { policy: ConsolePolicy, ability: 'view' },
   * })
   * ```
   *
   * They run before {@link authorize}. Decorators alone do not configure
   * access: without `authorize` the console still answers 403 in production.
   *
   * Every mounted controller is also marked open to `@nestjs/authorization`'s
   * deny-by-default global `AuthorizationGuard` (as `@Can.Anyone()` would), so
   * that guard does not lock the console out; `authorize` decides. A `Can(...)`
   * passed here is still enforced.
   *
   * The public client-error beacon (`ClientErrorController`, see
   * {@link ClientErrorsOptions}) does NOT take these decorators: guests' browsers
   * must reach it.
   *
   * Applied to a fresh subclass per registration, so decorators never leak
   * between `forRoot` calls. With `forRootAsync`, pass it as the static
   * top-level `decorators` (not from the factory).
   */
  decorators?: ClassDecorator[];
  /**
   * Class decorators for the MCP controller (`POST <path>/api/mcp`) only. When
   * set, they REPLACE {@link decorators} on that route; the API and the live
   * stream keep `decorators`. Leave it out and the MCP route takes
   * `decorators` like the rest.
   *
   * Use it when the coding agent signs in differently from the people on the
   * dashboard: an agent client sends `Authorization: Bearer <key>`, a browser
   * sends a session cookie. With `@nestjs/authentication`, keep each
   * credential to its routes with `Authenticate({ providers })`:
   *
   * ```ts
   * TelescopeModule.forRoot({
   *   mcp: true,
   *   decorators: [Authenticate({ providers: [SessionCookieProvider] }), Can(ConsolePolicy, 'view')],
   *   mcpDecorators: [Authenticate({ providers: [TelescopeAgentKey] }), Can(ConsolePolicy, 'view')],
   * })
   * ```
   *
   * where `TelescopeAgentKey` is your `ApiKeyProvider` subclass. Access is
   * still decided by {@link mcpAuthorize} (or {@link authorize}).
   * With `forRootAsync`, pass it as a static top-level option, like
   * `decorators`. Ignored with `routes: false`.
   */
  mcpDecorators?: ClassDecorator[];
  /**
   * `false` mounts NO controller; every provider (capture, storage, watchers,
   * pruning, alerts, the services below) still runs. Serve the routes you want
   * from controllers of your own, protected with {@link UseConsoleAuthorize}
   * (the same `authorize` contract) or ordinary Nest decorators — the same
   * "mount it yourself" path as `@nestjs/mcp`'s `path: false`:
   *
   * ```ts
   * @Controller('ops/telescope/api')
   * @UseConsoleAuthorize({ authorize: { policy: ConsolePolicy, ability: 'view' } })
   * class ConsoleApi extends TelescopeController {}
   *
   * @Module({
   *   imports: [TelescopeModule.forRoot({ path: 'ops/telescope', routes: false })],
   *   controllers: [ConsoleApi],
   * })
   * ```
   *
   * Each exported controller (`TelescopeController`, `StreamController`,
   * `ClientErrorController`, `TelescopeMcpController`) can be extended this
   * way; its dependencies are exported by the module. The base classes carry
   * no guard of their own, so what you put on them is the whole gate.
   *
   * Named `routes`, not `path: false`, because `path` keeps a job without
   * routes: it is the base the request-capture self-skip and the UI's asset
   * URLs use, so set it to where you mount the controllers. `decorators`,
   * `authorize` and `mcpAuthorize` only apply to mounted controllers and are
   * ignored here. With `forRootAsync`,
   * pass it as the static top-level `routes`. Default `true`.
   */
  routes?: boolean;
  /**
   * Extra `imports` merged into `TelescopeModule`'s own dynamic module — the DI
   * resolution path for whatever the {@link decorators} need (e.g. the module
   * providing a guard passed through `UseGuards(...)`).
   */
  imports?: DynamicModule['imports'];
}

export interface TelescopeOptionsFactory {
  createTelescopeOptions(): Promise<TelescopeModuleOptions> | TelescopeModuleOptions;
}

export const TELESCOPE_OPTIONS = Symbol('TELESCOPE_OPTIONS');
export const TELESCOPE_STORAGE = Symbol('TELESCOPE_STORAGE');
export const TELESCOPE_CONFIG = Symbol('TELESCOPE_CONFIG');
/** Kept for future DI use; the registry reads `options.queueManagers` directly. */
export const QUEUE_MANAGERS = Symbol('QUEUE_MANAGERS');
/** Resolved ExtensionRegistry (built + boot-validated from options.extensions). */
export const TELESCOPE_EXTENSIONS = Symbol('TELESCOPE_EXTENSIONS');
