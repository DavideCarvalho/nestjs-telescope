// packages/core/src/nest/telescope-request.middleware.ts
import { Inject, Injectable, type NestMiddleware, Optional } from '@nestjs/common';
import { EntryType } from '../entry/entry.js';
import type { ProfileHandle } from '../profiling/profiler.service.js';
import { ProfilerService } from '../profiling/profiler.service.js';
import { normalizeRoute } from '../query/normalize-route.js';
import { normalizeRequest } from './platform-request.js';
import {
  type RequestCaptureOptions,
  TELESCOPE_OPTIONS,
  type TelescopeHttpRequest,
  type TelescopeModuleOptions,
  toTelescopeHttpRequest,
} from './telescope.options.js';
import { TelescopeService } from './telescope.service.js';

interface FinishableResponse {
  statusCode: number;
  once(event: 'finish', listener: () => void): void;
}

/**
 * Default `requestCapture.maxBodyBytes`: bodies over 128 KiB are not captured.
 * ON by default — this is the safe-by-default fix for a synchronous redaction
 * walk over a giant decoded body stalling the event loop.
 */
const DEFAULT_MAX_BODY_BYTES = 131_072;

/**
 * Default `requestCapture.skipBodyContentTypes`: binary/streamed upload
 * bodies whose captured "payload" is never useful and can be arbitrarily
 * large (e.g. a tus resumable-upload PATCH chunk).
 */
const DEFAULT_SKIP_BODY_CONTENT_TYPES: (string | RegExp)[] = [
  'application/offset+octet-stream',
  'application/octet-stream',
  'multipart/form-data',
];

/** Resolved (defaults-applied) `requestCapture` config, computed once per middleware instance. */
interface ResolvedRequestCapture {
  maxBodyBytes: number | false;
  skipBodyContentTypes: (string | RegExp)[];
  skipBody: ((request: TelescopeHttpRequest) => boolean) | undefined;
}

function resolveRequestCapture(options: RequestCaptureOptions | undefined): ResolvedRequestCapture {
  return {
    maxBodyBytes: options?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    skipBodyContentTypes: options?.skipBodyContentTypes ?? DEFAULT_SKIP_BODY_CONTENT_TYPES,
    skipBody: options?.skipBody,
  };
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

/** First string value of a (possibly multi-value) header, case-sensitive on `name`. */
function headerValue(headers: Record<string, unknown>, name: string): string | undefined {
  const value = headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

/** Parsed `content-length` header, or `undefined` when absent/non-numeric. */
function contentLengthOf(headers: Record<string, unknown>): number | undefined {
  const raw = headerValue(headers, 'content-length');
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Whether `contentType` matches any `skipBodyContentTypes` pattern: a `string`
 * pattern matches as a case-insensitive PREFIX (so `'multipart/form-data'`
 * matches a value carrying a `; boundary=...` suffix); a `RegExp` is
 * `.test()`-ed against the raw header value.
 */
function matchesContentType(contentType: string, patterns: (string | RegExp)[]): boolean {
  const lowerContentType = contentType.toLowerCase();
  return patterns.some((pattern) =>
    typeof pattern === 'string'
      ? lowerContentType.startsWith(pattern.toLowerCase())
      : pattern.test(contentType),
  );
}

/**
 * O(1) byte-size estimate for the size gate: the `content-length` header when
 * present, else a string/Buffer/TypedArray body's own length. Deliberately
 * NEVER `JSON.stringify`s a parsed body to measure it — that IS the
 * synchronous walk this gate exists to avoid — so a parsed-object body
 * without `content-length` returns `undefined` and the size gate is skipped
 * for it (falls through to the content-type/skipBody gates instead).
 */
function estimateBodyBytes(body: unknown, contentLength: number | undefined): number | undefined {
  if (contentLength !== undefined) return contentLength;
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (Buffer.isBuffer(body)) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return undefined;
}

/**
 * Applies the `requestCapture` gates (content-type → size → predicate) to the
 * raw request body BEFORE it ever reaches `TelescopeService.record()` — the
 * whole point being that the synchronous redaction walk never sees a skipped
 * body. Runs synchronously; a matched gate replaces the body with a marker
 * string. Every other request-entry field (method/path/status/duration/user/
 * headers) is captured exactly as before regardless of this outcome.
 */
function gateRequestPayload(
  req: unknown,
  request: { headers: Record<string, unknown> },
  capture: ResolvedRequestCapture,
): unknown {
  const body = readPayload(req);
  const contentType = headerValue(request.headers, 'content-type');

  if (contentType !== undefined && matchesContentType(contentType, capture.skipBodyContentTypes)) {
    return `[Skipped: ${contentType}]`;
  }

  if (capture.maxBodyBytes !== false) {
    const estimatedBytes = estimateBodyBytes(body, contentLengthOf(request.headers));
    if (estimatedBytes !== undefined && estimatedBytes > capture.maxBodyBytes) {
      return `[Skipped: ${estimatedBytes} bytes > ${capture.maxBodyBytes} bytes]`;
    }
  }

  if (capture.skipBody?.(toTelescopeHttpRequest(req))) {
    return '[Skipped: skipBody predicate]';
  }

  return body;
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
  /** Resolved once at construction — the per-request hot path never rebuilds this. */
  private readonly captureConfig: ResolvedRequestCapture;

  constructor(
    @Inject(TelescopeService) private readonly service: TelescopeService,
    // ProfilerService is OPTIONAL so hosts/tests constructing the middleware
    // directly (e.g. `telescopeRequestCapture`) keep working unchanged. When the
    // module DI provides it (the normal path), it's injected; otherwise profiling
    // is simply inert. The service itself is a no-op while profiling is disabled.
    @Optional()
    @Inject(ProfilerService)
    private readonly profiler: ProfilerService | undefined = undefined,
    // Also OPTIONAL, for the same reason: `telescopeRequestCapture()` constructs
    // this class directly with no DI container, so `requestCapture` just falls
    // back to its defaults (128 KiB cap + the binary content-type list) there.
    @Optional()
    @Inject(TELESCOPE_OPTIONS)
    moduleOptions: TelescopeModuleOptions | undefined = undefined,
  ) {
    this.captureConfig = resolveRequestCapture(moduleOptions?.requestCapture);
  }

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
            // guards before this finish callback fires. The body first passes
            // through the `requestCapture` gates (content-type/size/predicate) —
            // a skipped body never reaches the Recorder's synchronous redaction
            // walk. What does get through is still redacted (masking passwords/
            // tokens) like any other content.
            payload: gateRequestPayload(req, request, this.captureConfig),
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
  options?: Pick<TelescopeModuleOptions, 'requestCapture'>,
): (req: unknown, res: unknown, next: (error?: unknown) => void) => void {
  // Hosts on this manual path (setGlobalPrefix apps) don't go through module DI,
  // so the capture gates are passed here — same shape as the module option:
  // `telescopeRequestCapture(service, { requestCapture: { skipBody: ... } })`.
  // Omitted → the safe defaults (128 KiB cap + binary content-type list).
  const middleware = new TelescopeRequestMiddleware(service, undefined, options);
  return (req, res, next) => middleware.use(req, res, next);
}
