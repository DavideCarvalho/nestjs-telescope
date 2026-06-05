// packages/core/src/http/http-client.watcher.ts
import { Logger } from '@nestjs/common';
import type { HttpClientContent } from '../entry/content.js';
import { EntryType } from '../entry/entry.js';
import type { Watcher, WatcherContext } from '../nest/watcher.js';
import { normalizeHttpTarget } from '../query/normalize-route.js';
import {
  type AxiosErrorLike,
  type AxiosInterceptorLike,
  type AxiosRequestConfigLike,
  type CustomAxiosSource,
  isCustomAxiosSource,
} from './axios-source.js';

export interface HttpClientWatcherOptions {
  /** Outbound calls at/above this many ms get a 'slow' tag. Default 1000. */
  slowMs?: number;
  /** Time source; injectable for tests. Default wall clock. */
  clock?: { now(): number };
  /**
   * An axios instance (or {@link CustomAxiosSource} for lazy resolution) to
   * capture alongside the global `fetch`. NestJS apps mostly call out through
   * `@nestjs/axios`'s `HttpService`, whose `axiosRef` is exactly an
   * {@link AxiosInterceptorLike}; in Node that traffic uses the http adapter and
   * is invisible to the `fetch` patch. Pass the instance (or a source that
   * resolves `HttpService` from `ctx.moduleRef`) to capture it via axios's
   * public interceptor API — no monkey-patching.
   */
  axios?: AxiosInterceptorLike | CustomAxiosSource;
}

/** Query-param keys whose VALUES are redacted from a captured URL (key-based
 *  content redaction can't reach a URL string leaf, so we sanitize here). */
const SENSITIVE_PARAM =
  /(token|secret|password|passwd|api[-_]?key|access[-_]?key|auth|credential)/i;
const REDACTED = '[REDACTED]';

/** Marks a wrapped `fetch` so we patch the global exactly once. `Symbol.for`
 *  (global registry) is deliberate: if two copies of core load, both see the
 *  same marker and neither double-wraps the other's wrapper. */
const PATCHED = Symbol.for('@dudousxd/nestjs-telescope:httpClientPatched');

/** Axios instances already wired by ANY watcher in this module copy. Kept
 *  module-level (not per-watcher) so that two `HttpClientWatcher`s sharing one
 *  axios instance — or the same watcher registered twice — never install
 *  duplicate interceptors and double-record. Mirrors the cross-instance
 *  idempotency of the cache watcher's `Symbol.for` marker, but as a `WeakSet`
 *  so we don't mutate the host's object. */
const INSTRUMENTED_AXIOS = new WeakSet<AxiosInterceptorLike>();

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

/**
 * Sanitize a raw URL string for storage: strip userinfo (`user:pass@`) and
 * redact sensitive query-param VALUES, then return `{ url, host }`. A relative
 * or otherwise unparseable URL is kept verbatim with `host: null`.
 *
 * Extracted so the `fetch` and axios paths sanitize IDENTICALLY — both must
 * never leak credentials/secrets, and downstream entries must be
 * indistinguishable. Key-based content redaction can't reach a URL string leaf,
 * which is why this URL-level pass exists.
 */
function sanitizeUrl(rawUrl: string): { url: string; host: string | null } {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.host;
    parsed.username = '';
    parsed.password = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_PARAM.test(key)) parsed.searchParams.set(key, REDACTED);
    }
    return { url: parsed.toString(), host };
  } catch {
    // Relative/invalid URL: keep the raw string, no host.
    return { url: rawUrl, host: null };
  }
}

/** Pull method/url/host out of fetch's (input, init) without throwing. The
 *  returned `url` is sanitized via {@link sanitizeUrl}: userinfo stripped and
 *  sensitive query-param values redacted, so credentials/secrets never reach
 *  storage. */
function describeRequest(
  input: FetchInput,
  init: FetchInit,
): { method: string; url: string; host: string | null } {
  let rawUrl = '';
  let method = 'GET';
  if (typeof input === 'string') rawUrl = input;
  else if (input instanceof URL) rawUrl = input.href;
  else if (input instanceof Request) {
    rawUrl = input.url;
    method = input.method;
  }
  if (init && typeof init.method === 'string') method = init.method;

  const { url, host } = sanitizeUrl(rawUrl);
  return { method: method.toUpperCase(), url, host };
}

/** True for a plain object literal (`{}` / `Object.create(null)`) — the only
 *  `params` shape we serialize. Arrays, `URLSearchParams`, class instances, etc.
 *  are skipped rather than guessing axios's paramsSerializer semantics. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Reconstruct method/url/host from an axios request config, mirroring fetch's
 * {@link describeRequest} so axios and fetch entries are indistinguishable.
 *
 * The full URL is `baseURL` joined to `url` (axios resolves relative `url`
 * against `baseURL`). Plain-object `params` are appended as a conservative
 * query string; any other `params` shape (URLSearchParams, arrays, custom
 * serializers) is skipped — we never reimplement axios's serializer. The result
 * runs through {@link sanitizeUrl} for the same redaction as fetch.
 */
function describeAxiosRequest(config: AxiosRequestConfigLike): {
  method: string;
  url: string;
  host: string | null;
} {
  const method = (config.method ?? 'GET').toUpperCase();
  const base = config.baseURL ?? '';
  const path = config.url ?? '';

  // Join baseURL + url the way axios does: absolute `url` wins; otherwise
  // concatenate, collapsing a duplicated slash at the seam.
  let rawUrl: string;
  if (base && path && !/^https?:\/\//i.test(path)) {
    rawUrl = `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  } else {
    rawUrl = path || base;
  }

  if (isPlainObject(config.params)) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(config.params)) {
      if (value === undefined || value === null) continue;
      search.append(key, String(value));
    }
    const qs = search.toString();
    if (qs) rawUrl += (rawUrl.includes('?') ? '&' : '?') + qs;
  }

  const { url, host } = sanitizeUrl(rawUrl);
  return { method, url, host };
}

/** Narrows an unknown rejection (axios passes `unknown` through interceptors)
 *  to the {@link AxiosErrorLike} fields we read. Always returns an object so the
 *  caller can read optional `config`/`response` without a cast. A real axios
 *  error carries `config` and (on an HTTP response) `response.status`; a
 *  transport failure has no `response`, which the caller records as `null`. */
function asAxiosError(error: unknown): AxiosErrorLike {
  if (typeof error !== 'object' || error === null) return {};
  const candidate: { config?: unknown; response?: unknown } = error;
  const result: AxiosErrorLike = {};
  // `config` only needs to be a non-null object — every field we read off it is
  // optional, so we don't probe further.
  if (typeof candidate.config === 'object' && candidate.config !== null) {
    result.config = candidate.config;
  }
  const response = candidate.response;
  if (
    typeof response === 'object' &&
    response !== null &&
    'status' in response &&
    typeof response.status === 'number'
  ) {
    result.response = { status: response.status };
  }
  return result;
}

/**
 * Captures outbound HTTP calls made via the global `fetch` and, optionally, via
 * an axios instance (`@nestjs/axios`'s `HttpService.axiosRef` or a bare axios),
 * correlated to the request/job that made them.
 *
 * Both paths run inside the caller's async context, so the active ALS batch
 * (set by the request middleware) is live when we record — no extra wiring is
 * needed for correlation. Recording is guarded so a telescope failure can never
 * change the host's HTTP result, and the host's network error is always
 * re-thrown. The `fetch` patch is idempotent across instances via a symbol
 * marker; axios instrumentation is idempotent via a module-level `WeakSet` of
 * instrumented instances (so two watchers sharing one axios don't double-wrap).
 *
 * ## Why axios needs its own path
 * NestJS apps mostly call out through `@nestjs/axios`. In Node, axios uses the
 * http adapter (not `fetch`), so those calls bypass the `fetch` patch entirely
 * and are invisible without this. We attach via axios's PUBLIC interceptor API
 * (`interceptors.request/response.use`) — never monkey-patching — so we don't
 * fight axios internals or other interceptors the host installs.
 *
 * @remarks
 * Only the global `fetch` and an explicitly-provided axios instance are
 * instrumented. Clients that bypass both (a custom `http.request`, native
 * addons) are not captured. The global `fetch` is replaced for the process
 * lifetime (not restored on shutdown) — appropriate for an always-on
 * observability tool. The captured URL has userinfo stripped and sensitive
 * query-param values redacted; key-based content redaction does not otherwise
 * apply to the URL string.
 *
 * **Double-capture (edge case):** if an axios instance is explicitly configured
 * with a `fetch` adapter AND that `fetch` is our patched global, a single call
 * could record twice (once per path). Node's default is the http adapter, so
 * this only happens when a host opts into the fetch adapter; we don't build
 * detection machinery for it.
 */
export class HttpClientWatcher implements Watcher {
  readonly type = EntryType.HttpClient;
  private readonly logger = new Logger(HttpClientWatcher.name);
  private readonly slowMs: number;
  private readonly clock: { now(): number };
  private readonly axiosSource: AxiosInterceptorLike | CustomAxiosSource | undefined;

  /** Per-request start times, keyed by the axios config object. A `WeakMap`
   *  (not a symbol stamped onto the config) keeps the host's object pristine and
   *  lets entries be GC'd if a request never completes — no leak, no mutation. */
  private readonly axiosStartedAt = new WeakMap<AxiosRequestConfigLike, number>();

  constructor(options: HttpClientWatcherOptions = {}) {
    this.slowMs = options.slowMs ?? 1000;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.axiosSource = options.axios;
  }

  register(ctx: WatcherContext): void {
    this.patchFetch(ctx);
    this.registerAxios(ctx);
  }

  /** Patch the global `fetch` exactly as before — unchanged behavior. Idempotent
   *  process-wide via the {@link PATCHED} marker. Pulled into its own method so
   *  axios instrumentation can run independently (and still attach even when
   *  `fetch` is missing or already patched). */
  private patchFetch(ctx: WatcherContext): void {
    const current = globalThis.fetch;
    if (typeof current !== 'function') {
      this.logger.warn(
        'HttpClientWatcher: global fetch is unavailable; outbound calls will not be captured.',
      );
      return;
    }
    if ((current as { [PATCHED]?: boolean })[PATCHED]) return;

    const watcher = this;
    const patched = async function patchedFetch(
      input: FetchInput,
      init?: FetchInit,
    ): Promise<Response> {
      const startedAt = watcher.clock.now();
      const { method, url, host } = describeRequest(input, init);
      try {
        const response = await current(input, init);
        watcher.safeRecord(ctx, {
          method,
          url,
          host,
          statusCode: response.status,
          durationMs: watcher.clock.now() - startedAt,
        });
        return response;
      } catch (error) {
        watcher.safeRecord(ctx, {
          method,
          url,
          host,
          statusCode: null,
          durationMs: watcher.clock.now() - startedAt,
        });
        throw error; // never swallow the host's network error
      }
    };
    (patched as { [PATCHED]?: boolean })[PATCHED] = true;
    globalThis.fetch = patched as typeof globalThis.fetch;
  }

  /** Wire axios capture if an axios source was provided. The bare-instance form
   *  attaches immediately; the {@link CustomAxiosSource} form hands the host an
   *  `attach` callback so it can resolve `HttpService` from `ctx.moduleRef`
   *  lazily (the instance often doesn't exist yet at construction time). */
  private registerAxios(ctx: WatcherContext): void {
    const source = this.axiosSource;
    if (source === undefined) return;

    if (isCustomAxiosSource(source)) {
      source.instrument((instance) => this.attachAxios(instance, ctx), ctx);
      return;
    }
    this.attachAxios(source, ctx);
  }

  /** Install request/response interceptors on an axios instance via its public
   *  API. Idempotent via the module-level {@link INSTRUMENTED_AXIOS} set: a
   *  second call (re-registration, or two watchers sharing one instance) is a
   *  no-op so no call double-records.
   *
   *  Timing uses {@link axiosStartedAt} — a `WeakMap<config, number>` — rather
   *  than stamping the config: axios passes the SAME config object from the
   *  request interceptor through to the response/error interceptor, so the
   *  config is a stable key, and a `WeakMap` neither mutates the host's object
   *  nor leaks if a request never resolves. */
  private attachAxios(instance: AxiosInterceptorLike, ctx: WatcherContext): void {
    if (INSTRUMENTED_AXIOS.has(instance)) return;
    INSTRUMENTED_AXIOS.add(instance);

    instance.interceptors.request.use((config) => {
      this.axiosStartedAt.set(config, this.clock.now());
      return config;
    });

    instance.interceptors.response.use(
      (response) => {
        this.recordAxios(ctx, response.config, response.status);
        return response;
      },
      (error: unknown) => {
        const axiosError = asAxiosError(error);
        this.recordAxios(ctx, axiosError.config, axiosError.response?.status ?? null);
        // Re-throw so the host's error handling is untouched — axios expects a
        // rejected promise from a response interceptor's onRejected.
        return Promise.reject(error);
      },
    );
  }

  /** Compute duration from the stored start time, describe the target, and hand
   *  the entry to {@link safeRecord} — the same content/tags/family-hash shape as
   *  the `fetch` path, so axios and fetch entries are indistinguishable. A
   *  missing start time (interceptor order, or a config we never saw) records
   *  `durationMs: 0` rather than dropping the entry. */
  private recordAxios(
    ctx: WatcherContext,
    config: AxiosRequestConfigLike | undefined,
    statusCode: number | null,
  ): void {
    const safeConfig: AxiosRequestConfigLike = config ?? {};
    const startedAt = config ? this.axiosStartedAt.get(config) : undefined;
    if (config) this.axiosStartedAt.delete(config);
    const durationMs = startedAt === undefined ? 0 : Math.max(0, this.clock.now() - startedAt);
    const { method, url, host } = describeAxiosRequest(safeConfig);
    this.safeRecord(ctx, { method, url, host, statusCode, durationMs });
  }

  /** Hand an entry to the Recorder, swallowing any failure so a telescope bug
   *  can never alter the host's HTTP call. */
  private safeRecord(ctx: WatcherContext, content: HttpClientContent): void {
    try {
      const tags: string[] = [];
      if (content.host) tags.push(`host:${content.host}`);
      // A 4xx is a valid response, not a transport failure — only 5xx / network errors are 'failed'.
      if (content.statusCode === null || content.statusCode >= 500) tags.push('failed');
      if (content.durationMs >= this.slowMs) tags.push('slow');

      ctx.record({
        type: EntryType.HttpClient,
        content,
        // Group by method + host + normalized path so the same external endpoint
        // aggregates regardless of ids — the pulse slow-outgoing hotspot key/label.
        familyHash: normalizeHttpTarget(content.method, content.url),
        durationMs: content.durationMs,
        ...(tags.length > 0 ? { tags } : {}),
      });
    } catch (recordError) {
      const message = recordError instanceof Error ? recordError.message : String(recordError);
      this.logger.error(`HttpClientWatcher: failed to record entry: ${message}`);
    }
  }
}
