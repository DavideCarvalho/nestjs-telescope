// packages/core/src/nest/telescope-request.middleware.ts
import { Inject, Injectable, type NestMiddleware, Optional } from '@nestjs/common';
import { EntryType } from '../entry/entry.js';
import type { ProfileHandle } from '../profiling/profiler.service.js';
import { ProfilerService } from '../profiling/profiler.service.js';
import { normalizeRoute } from '../query/normalize-route.js';
import { normalizeRequest } from './platform-request.js';
import { TelescopeService } from './telescope.service.js';

interface FinishableResponse {
  statusCode: number;
  once(event: 'finish', listener: () => void): void;
}

/**
 * The dashboard UI, its API and assets are all mounted under the configured
 * path prefix; skip them to avoid self-capture of the dashboard's own polling.
 */
function isTelescopePath(url: string, prefix: string): boolean {
  const queryStart = url.indexOf('?');
  const path = queryStart === -1 ? url : url.slice(0, queryStart);
  return path === prefix || path.startsWith(`${prefix}/`);
}

function asFinishable(res: unknown): FinishableResponse | null {
  const r = res as { statusCode?: unknown; once?: unknown };
  return typeof r?.once === 'function' ? (res as FinishableResponse) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Whether the request was re-issued by Telescope's replay endpoint. */
function hasReplayHeader(headers: Record<string, unknown>): boolean {
  const value = headers['x-telescope-replay'];
  if (typeof value === 'string') return value !== '';
  return Array.isArray(value) && value.length > 0;
}

/** The parsed request body (Express/Fastify), or `null` when none is present. */
function readPayload(request: unknown): unknown {
  return isRecord(request) && 'body' in request ? request.body : null;
}

/**
 * Resolve the authenticated user for a request. Prefers the host's
 * `resolveUser` hook; otherwise reads `request.user` (the Passport/guard
 * convention). Never throws — a faulty hook or missing user yields `null`.
 */
function readUser(request: unknown, resolveUser?: (request: unknown) => unknown): unknown {
  if (resolveUser !== undefined) {
    try {
      return resolveUser(request) ?? null;
    } catch {
      return null;
    }
  }
  return isRecord(request) && 'user' in request ? (request.user ?? null) : null;
}

@Injectable()
export class TelescopeRequestMiddleware implements NestMiddleware {
  constructor(
    @Inject(TelescopeService) private readonly service: TelescopeService,
    // ProfilerService is OPTIONAL so hosts/tests constructing the middleware
    // directly (e.g. `telescopeRequestCapture`) keep working unchanged. When the
    // module DI provides it (the normal path), it's injected; otherwise profiling
    // is simply inert. The service itself is a no-op while profiling is disabled.
    @Optional()
    @Inject(ProfilerService)
    private readonly profiler: ProfilerService | undefined = undefined,
  ) {}

  use(req: unknown, res: unknown, next: (error?: unknown) => void): void {
    const request = normalizeRequest(req);

    // Skip telescope's own routes (dashboard, API, assets) before any batch/recording work.
    // .exclude() can't do this reliably under a global prefix, so we gate in-middleware instead.
    if (isTelescopePath(request.url, `/${this.service.path}`)) {
      next();
      return;
    }

    // Open the request batch for the whole downstream async execution.
    this.service.beginBatch('http');

    const startedAt = Date.now();
    const response = asFinishable(res);
    const route = normalizeRoute(request.method, request.url);

    // Opt-in CPU profiling: a single cheap boolean gate when disabled. When a
    // request is selected, begin the capture now and stop it on finish; the
    // recorded `cpu_profile` entry inherits the active batch/trace context.
    let profile: ProfileHandle | null = null;
    if (this.profiler?.shouldProfile(route)) {
      profile = this.profiler.begin(route);
    }

    // A replay (re-issued from the dashboard) carries `x-telescope-replay: 1`.
    // Tag its captured entry so the dashboard/agent can tell replays apart from
    // organic traffic (and a host could choose to skip them entirely).
    const isReplay = hasReplayHeader(request.headers);

    if (response) {
      response.once('finish', () => {
        this.service.record({
          type: EntryType.Request,
          // A readable normalized route (e.g. "GET /api/base/:id/mel") groups
          // request entries by endpoint via the indexed family_hash column and
          // doubles as the human label — no content hydration needed.
          familyHash: route,
          ...(isReplay ? { tags: ['replay'] } : {}),
          content: {
            method: request.method,
            uri: request.url,
            headers: request.headers,
            // `req.body` is parsed by the host body-parser and `req.user` set by
            // guards before this finish callback fires. Both are passed raw and
            // redacted by the Recorder (masking passwords/tokens).
            payload: readPayload(req),
            user: readUser(req, this.service.resolveUser),
            ip: request.ip,
            statusCode: response.statusCode,
          },
          durationMs: Date.now() - startedAt,
        });
        // Stop + record the profile within the same async context so its
        // `cpu_profile` entry shares this request's batchId/traceId. Fire-and-
        // forget: `end` never throws and never blocks the response.
        if (profile !== null) {
          void this.profiler?.end(profile, route);
        }
      });
    }

    next();
  }
}

/**
 * Builds a framework-agnostic `(req, res, next)` request-capture handler for
 * hosts that register it globally via `app.use(...)` in their bootstrap —
 * required when the app uses `setGlobalPrefix(...)`, which scopes NestJS module
 * middleware so the built-in capture would only see `/`. Pair with
 * `TelescopeModule.forRoot({ registerRequestMiddleware: false })`.
 *
 * @example
 *   const app = await NestFactory.create(AppModule);
 *   app.use(telescopeRequestCapture(app.get(TelescopeService)));
 */
export function telescopeRequestCapture(
  service: TelescopeService,
): (req: unknown, res: unknown, next: (error?: unknown) => void) => void {
  const middleware = new TelescopeRequestMiddleware(service);
  return (req, res, next) => middleware.use(req, res, next);
}
