// packages/core/src/alerts/integrations/http.ts
/**
 * The HTTP transport every integration (on-call, chat, heartbeats, status pages)
 * shares: a hard per-attempt timeout, bounded retries with exponential backoff,
 * and error messages that NEVER carry the request URL, headers or body — those
 * hold routing keys, bot tokens and API keys.
 */

/** Injectable `fetch` seam (tests drive it with a mock; defaults to global `fetch`). */
export type HttpFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<unknown>;

/** Retry / timeout knobs shared by every integration. */
export interface RetryOptions {
  /** Extra attempts after the first one. Default `2` (3 attempts total). */
  retries?: number;
  /** First backoff delay in ms; doubled on each retry. Default `500`. */
  backoffMs?: number;
  /** Per-attempt timeout in ms. Default `5000`. */
  timeoutMs?: number;
}

/** Test seams on top of {@link RetryOptions}. */
export interface HttpDeps extends RetryOptions {
  fetch?: HttpFetch;
  /** Backoff sleep seam. Defaults to an unref'd `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

export interface HttpRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH';
  url: string;
  headers?: Record<string, string>;
  /** JSON-serialized when an object; sent as-is when a string. */
  body?: unknown;
}

/** The parts of a response an integration reads. */
export interface HttpResult {
  status: number;
  /** Parsed JSON body, or `null` when there is none / it isn't JSON. */
  json: unknown;
}

const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 500;
const DEFAULT_TIMEOUT_MS = 5_000;
/** Never wait longer than this for a `Retry-After`. */
const MAX_RETRY_AFTER_MS = 30_000;

/** A failed delivery. The message names the status only — never the URL or a secret. */
export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    /** Server-requested wait (`Retry-After`), in ms, when it sent one. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function readStatus(response: unknown): number {
  if (response !== null && typeof response === 'object' && 'status' in response) {
    const status = (response as { status: unknown }).status;
    if (typeof status === 'number') return status;
  }
  // Test doubles that resolve `undefined` count as success.
  return 200;
}

function readRetryAfterMs(response: unknown): number | null {
  if (response === null || typeof response !== 'object' || !('headers' in response)) return null;
  const headers = (response as { headers: unknown }).headers;
  if (headers === null || typeof headers !== 'object' || !('get' in headers)) return null;
  const raw = (headers as { get: (name: string) => string | null }).get('retry-after');
  if (raw === null) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

async function readJson(response: unknown): Promise<unknown> {
  if (response === null || typeof response !== 'object') return null;
  if ('json' in response && typeof (response as { json: unknown }).json === 'function') {
    try {
      return await (response as { json: () => Promise<unknown> }).json();
    } catch {
      return null;
    }
  }
  return null;
}

/** 408, 425, 429 and every 5xx are worth another try; other 4xx are config errors. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function attempt(
  fetchImpl: HttpFetch,
  request: HttpRequest,
  timeoutMs: number,
): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const headers: Record<string, string> = { ...request.headers };
  let body: string | undefined;
  if (request.body !== undefined) {
    if (typeof request.body === 'string') {
      body = request.body;
      headers['content-type'] ??= 'text/plain; charset=utf-8';
    } else {
      body = JSON.stringify(request.body);
      headers['content-type'] ??= 'application/json';
    }
  }
  let response: unknown;
  try {
    response = await fetchImpl(request.url, {
      method: request.method ?? 'POST',
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: controller.signal,
    });
  } catch (error: unknown) {
    // Don't echo the underlying message: some runtimes include the URL in it.
    const aborted = controller.signal.aborted;
    throw new DeliveryError(
      aborted ? `timed out after ${timeoutMs}ms` : `network error (${errorName(error)})`,
      null,
      true,
    );
  } finally {
    clearTimeout(timer);
  }
  const status = readStatus(response);
  if (status < 200 || status >= 300) {
    throw new DeliveryError(
      `HTTP ${status}`,
      status,
      isRetryableStatus(status),
      readRetryAfterMs(response),
    );
  }
  return { status, json: await readJson(response) };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * Send one request, retrying network errors, timeouts, 408/425/429 and 5xx with
 * exponential backoff (a numeric `Retry-After` wins, capped at 30s). A 4xx
 * other than those fails at once — it's a configuration problem a retry can't fix.
 * Rejects with a {@link DeliveryError} whose message never contains the URL.
 */
export async function deliver(request: HttpRequest, deps: HttpDeps = {}): Promise<HttpResult> {
  const fetchImpl: HttpFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const sleep = deps.sleep ?? defaultSleep;
  const retries = Math.max(0, deps.retries ?? DEFAULT_RETRIES);
  const backoffMs = Math.max(0, deps.backoffMs ?? DEFAULT_BACKOFF_MS);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let lastError: DeliveryError | null = null;
  for (let tryIndex = 0; tryIndex <= retries; tryIndex++) {
    try {
      return await attempt(fetchImpl, request, timeoutMs);
    } catch (error: unknown) {
      if (!(error instanceof DeliveryError)) throw error;
      lastError = error;
      if (!error.retryable || tryIndex === retries) break;
      await sleep(error.retryAfterMs ?? backoffMs * 2 ** tryIndex);
    }
  }
  throw lastError ?? new DeliveryError('delivery failed', null, false);
}
