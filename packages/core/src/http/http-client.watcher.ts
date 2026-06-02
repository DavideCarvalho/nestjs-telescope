// packages/core/src/http/http-client.watcher.ts
import { Logger } from '@nestjs/common';
import type { HttpClientContent } from '../entry/content.js';
import { EntryType } from '../entry/entry.js';
import type { Watcher, WatcherContext } from '../nest/watcher.js';

export interface HttpClientWatcherOptions {
  /** Outbound calls at/above this many ms get a 'slow' tag. Default 1000. */
  slowMs?: number;
  /** Time source; injectable for tests. Default wall clock. */
  clock?: { now(): number };
}

/** Marks a wrapped `fetch` so we patch the global exactly once. */
const PATCHED = Symbol.for('@dudousxd/nestjs-telescope:httpClientPatched');

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

/** Pull method/url/host out of fetch's (input, init) without throwing. */
function describeRequest(
  input: FetchInput,
  init: FetchInit,
): { method: string; url: string; host: string | null } {
  let url = '';
  let method = 'GET';
  if (typeof input === 'string') url = input;
  else if (input instanceof URL) url = input.href;
  else if (input instanceof Request) {
    url = input.url;
    method = input.method;
  }
  if (init && typeof init.method === 'string') method = init.method;

  let host: string | null = null;
  try {
    host = new URL(url).host;
  } catch {
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
 * always-on observability tool.
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
      if (content.statusCode === null || content.statusCode >= 500) tags.push('failed');
      if (content.durationMs >= this.slowMs) tags.push('slow');

      ctx.record({
        type: EntryType.HttpClient,
        content,
        familyHash: `${content.method} ${content.host ?? ''}`.trim() || null,
        durationMs: content.durationMs,
        ...(tags.length > 0 ? { tags } : {}),
      });
    } catch (recordError) {
      const message = recordError instanceof Error ? recordError.message : String(recordError);
      this.logger.error(`HttpClientWatcher: failed to record entry: ${message}`);
    }
  }
}
