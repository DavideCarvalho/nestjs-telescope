// packages/core/src/http/http-client.watcher.ts
import { Logger } from '@nestjs/common';
import type { HttpClientContent } from '../entry/content.js';
import { EntryType } from '../entry/entry.js';
import type { Watcher, WatcherContext } from '../nest/watcher.js';
import { normalizeHttpTarget } from '../query/normalize-route.js';

export interface HttpClientWatcherOptions {
  /** Outbound calls at/above this many ms get a 'slow' tag. Default 1000. */
  slowMs?: number;
  /** Time source; injectable for tests. Default wall clock. */
  clock?: { now(): number };
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

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

/** Pull method/url/host out of fetch's (input, init) without throwing. The
 *  returned `url` is sanitized: userinfo stripped and sensitive query-param
 *  values redacted, so credentials/secrets never reach storage. */
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

  let host: string | null = null;
  let url = rawUrl;
  try {
    const parsed = new URL(rawUrl);
    host = parsed.host;
    parsed.username = '';
    parsed.password = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_PARAM.test(key)) parsed.searchParams.set(key, REDACTED);
    }
    url = parsed.toString();
  } catch {
    // Relative/invalid URL: keep the raw string, no host.
    host = null;
  }
  return { method: method.toUpperCase(), url, host };
}

/**
 * Captures outbound HTTP calls made via the global `fetch`, correlated to the
 * request/job that made them.
 *
 * `fetch` runs inside the caller's async context, so the active ALS batch (set
 * by the request middleware) is live when the wrapper records — no extra wiring
 * is needed for correlation. Recording is guarded so a telescope failure can
 * never change the host's HTTP result, and the host's network error is always
 * re-thrown. The patch is idempotent across instances via a symbol marker.
 *
 * @remarks
 * Only the global `fetch` is instrumented. Clients that bypass it (a custom
 * `http.request`, native addons) are not captured. The global is replaced for
 * the process lifetime (not restored on shutdown) — appropriate for an
 * always-on observability tool. The captured URL has userinfo stripped and
 * sensitive query-param values redacted; note that key-based content redaction
 * does not otherwise apply to the URL string.
 */
export class HttpClientWatcher implements Watcher {
  readonly type = EntryType.HttpClient;
  private readonly logger = new Logger(HttpClientWatcher.name);
  private readonly slowMs: number;
  private readonly clock: { now(): number };

  constructor(options: HttpClientWatcherOptions = {}) {
    this.slowMs = options.slowMs ?? 1000;
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  register(ctx: WatcherContext): void {
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
