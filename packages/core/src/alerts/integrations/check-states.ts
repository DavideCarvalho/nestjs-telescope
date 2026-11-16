// packages/core/src/alerts/integrations/check-states.ts
import { timingSafeEqual } from 'node:crypto';

/**
 * The "current check states" contract the uptime integrations (heartbeats,
 * status pages and the pull uptime endpoint) read: one entry per health check
 * (`ok` / `warn` / `down` / `unknown`), with an optional `app` so a source that
 * reports several services can scope per app.
 *
 * Telescope doesn't run health checks itself: the host supplies the source
 * (e.g. a cached `@nestjs/terminus` result mapped to this shape) through
 * `alerts.checkStates`, or publishes one with {@link publishCheckStates}.
 */

/** A check's status: `warn` is degraded but serving; `unknown` = not run yet. */
export type UptimeCheckStatus = 'ok' | 'warn' | 'down' | 'unknown';

/** One check's current state. */
export interface UptimeCheckState {
  /** Check name, e.g. `redis`, `postgres`, `disk`. */
  name: string;
  status: UptimeCheckStatus;
  /** The app/service the check belongs to, when the source reports several. */
  app?: string;
  /** Short human detail, e.g. `"PING timed out after 2s"`. */
  message?: string | null;
  /** When the check entered its current status (epoch ms or ISO-8601). */
  since?: number | string;
  /**
   * `false` for a check that is shown but must not mark the app unhealthy (it
   * still moves status page components). Default `true`.
   */
  critical?: boolean;
}

/** Returns the current check states. May be sync or async; must be cheap (cached). */
export type CheckStateSource = () => UptimeCheckState[] | Promise<UptimeCheckState[]>;

/** What the integrations report: `up`, `degraded` or `down`. */
export type HealthStatus = 'up' | 'degraded' | 'down';

const RANK: Record<HealthStatus, number> = { up: 0, degraded: 1, down: 2 };

/** A state's health, or `null` for `unknown` (not run yet: ignored). */
export function healthOf(state: UptimeCheckState): HealthStatus | null {
  switch (state.status) {
    case 'ok':
      return 'up';
    case 'warn':
      return 'degraded';
    case 'down':
      return 'down';
    default:
      return null;
  }
}

/** The worst health among `states` (unknown ones ignored); `up` when there are none. */
export function worstStatus(states: readonly UptimeCheckState[]): HealthStatus {
  let worst: HealthStatus = 'up';
  for (const state of states) {
    const health = healthOf(state);
    if (health !== null && RANK[health] > RANK[worst]) worst = health;
  }
  return worst;
}

/** The worst of two health statuses. */
export function worse(a: HealthStatus, b: HealthStatus): HealthStatus {
  return RANK[b] > RANK[a] ? b : a;
}

/** The states that belong to `app` (all of them when `app` is `null`). */
export function statesFor(
  states: readonly UptimeCheckState[],
  app: string | null,
): UptimeCheckState[] {
  return app === null ? [...states] : states.filter((state) => state.app === app);
}

/** The states that decide whether the app is healthy (`critical: false` ones don't). */
export function criticalStates(states: readonly UptimeCheckState[]): UptimeCheckState[] {
  return states.filter((state) => state.critical !== false);
}

/** One line naming every check that isn't up, e.g. `redis down: OOM; disk degraded`. */
export function describeProblems(states: readonly UptimeCheckState[]): string {
  return states
    .filter((state) => state.status === 'warn' || state.status === 'down')
    .map((state) => {
      const who = state.app !== undefined ? `${state.app}/${state.name}` : state.name;
      const message =
        state.message !== undefined && state.message !== null && state.message !== ''
          ? `: ${state.message}`
          : '';
      return `${who} ${healthOf(state)}${message}`;
    })
    .join('; ');
}

/** Read the source, never throwing. `null` means "health unknown". */
export async function readStates(
  source: CheckStateSource,
  logger: (message: string) => void,
): Promise<UptimeCheckState[] | null> {
  try {
    const states = await source();
    return Array.isArray(states) ? states : null;
  } catch (error: unknown) {
    logger(
      `Telescope health source failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// The plug point: whoever owns the checks can publish a source here
// ---------------------------------------------------------------------------

const SOURCE_KEY = Symbol.for('@dudousxd/nestjs-telescope:check-states');
const slot = globalThis as typeof globalThis & { [SOURCE_KEY]?: CheckStateSource | null };

/**
 * Publish the process-wide check-state source. Heartbeats, status pages and the
 * uptime endpoint read it when `alerts.checkStates` is not set (looked up on
 * every read, so a source published after boot is picked up). Pass `null` to
 * unpublish.
 */
export function publishCheckStates(source: CheckStateSource | null): void {
  slot[SOURCE_KEY] = source;
}

/** The published check-state source, or `null` when none is published. */
export function publishedCheckStates(): CheckStateSource | null {
  return slot[SOURCE_KEY] ?? null;
}

// ---------------------------------------------------------------------------
// Pull: an uptime endpoint for UptimeRobot / Better Stack / Uptime Kuma
// ---------------------------------------------------------------------------

export interface UptimeEndpointOptions {
  /** Where the check states come from. Default: the {@link publishCheckStates published} source. */
  source?: CheckStateSource;
  /**
   * Shared secret. When set, a request must carry it as `?token=` (see
   * `tokenQuery`) or in the `x-telescope-health-token` header (see `tokenHeader`).
   * Without it the endpoint answers `401`.
   */
  token?: string;
  /** Query-string parameter that may carry the token. Default `'token'`. */
  tokenQuery?: string;
  /** Header that may carry the token. Default `'x-telescope-health-token'`. */
  tokenHeader?: string;
  /** Status code for `degraded`. Default `200` (the app still serves). */
  degradedStatusCode?: number;
  /**
   * Include each check in the body. Default: `true` when a `token` is set,
   * `false` otherwise (an open endpoint only says up/degraded/down).
   */
  details?: boolean;
}

/** The body the endpoint returns. Keyword monitors can match `"status":"up"`. */
export interface UptimeBody {
  status: HealthStatus | 'unauthorized';
  app?: string;
  checks?: Array<{
    name: string;
    status: UptimeCheckStatus;
    app?: string;
    message?: string;
    critical?: boolean;
  }>;
  checkedAt?: string;
}

/**
 * Pure: the status code and body for a set of states. `up` → 200, `degraded` →
 * `degradedStatusCode` (200), `down` → 503. Scoped to an `app` that has no
 * states, the answer is `down`.
 */
export function uptimeResponse(
  states: readonly UptimeCheckState[],
  options: { degradedStatusCode?: number; details?: boolean; app?: string | null; now?: Date } = {},
): { statusCode: number; body: UptimeBody } {
  const scoped = statesFor(states, options.app ?? null);
  // An app with no states at all is not reporting: treat it as down.
  const unknownApp = options.app !== undefined && options.app !== null && scoped.length === 0;
  const status: HealthStatus = unknownApp ? 'down' : worstStatus(criticalStates(scoped));
  const statusCode =
    status === 'up' ? 200 : status === 'degraded' ? (options.degradedStatusCode ?? 200) : 503;
  const body: UptimeBody = {
    status,
    ...(options.app !== undefined && options.app !== null ? { app: options.app } : {}),
    ...(options.details === true
      ? {
          checks: scoped.map((state) => ({
            name: state.name,
            status: state.status,
            ...(state.app !== undefined ? { app: state.app } : {}),
            ...(typeof state.message === 'string' ? { message: state.message } : {}),
            ...(state.critical === false ? { critical: false } : {}),
          })),
        }
      : {}),
    checkedAt: (options.now ?? new Date()).toISOString(),
  };
  return { statusCode, body };
}

/** The parts of an incoming request the uptime handler reads (Express or Fastify). */
export interface UptimeRequestLike {
  query?: Record<string, unknown>;
  headers?: Record<string, string | string[] | undefined>;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function firstString(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first : undefined;
}

/**
 * A framework-neutral uptime handler for external monitors. It returns the
 * status code and body; the host's controller writes them:
 *
 * ```ts
 * const uptime = uptimeHandler({ token: process.env.UPTIME_TOKEN });
 *
 * @Get('uptime')
 * async check(@Req() req: Request, @Res() res: Response) {
 *   const { statusCode, body } = await uptime(req);
 *   res.status(statusCode).set('cache-control', 'no-store').json(body);
 * }
 * ```
 *
 * `?app=<name>` scopes the answer to one app. When the source fails, it answers
 * 503 — a monitor should treat "can't tell" as down. With no source configured
 * or published it is a plain liveness probe (`up` while the process answers).
 */
export function uptimeHandler(
  options: UptimeEndpointOptions = {},
): (request: UptimeRequestLike) => Promise<{ statusCode: number; body: UptimeBody }> {
  const queryName = options.tokenQuery ?? 'token';
  const headerName = (options.tokenHeader ?? 'x-telescope-health-token').toLowerCase();
  const details = options.details ?? options.token !== undefined;
  return async (request) => {
    const query = request.query ?? {};
    if (options.token !== undefined) {
      const presented =
        firstString(query[queryName]) ?? firstString(request.headers?.[headerName]) ?? '';
      if (!safeEqual(presented, options.token)) {
        return { statusCode: 401, body: { status: 'unauthorized' } };
      }
    }
    const appParam = firstString(query.app);
    const app = appParam !== undefined && appParam !== '' ? appParam : null;
    const source = options.source ?? publishedCheckStates();
    // No source at all: a liveness probe (the process answers, so it's up).
    const states = source === null ? [] : await readStates(source, () => {});
    if (states === null) {
      return { statusCode: 503, body: { status: 'down', checkedAt: new Date().toISOString() } };
    }
    return uptimeResponse(states, {
      details,
      app,
      ...(options.degradedStatusCode !== undefined
        ? { degradedStatusCode: options.degradedStatusCode }
        : {}),
    });
  };
}
