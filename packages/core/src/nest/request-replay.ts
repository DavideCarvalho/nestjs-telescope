// packages/core/src/nest/request-replay.ts
//
// Request REPLAY subsystem: re-issue a captured request entry against the local
// server so a developer can reproduce it from the dashboard. Extracted from the
// controller (which exposes it via `GET entries/:id/replay`) so the controller
// stays focused on routing — these are pure, self-contained helpers.
import type { RequestContent } from '../entry/content.js';

/** Outcome of a request replay (see {@link TelescopeController.replay}). */
export interface ReplayResult {
  /** HTTP status of the replayed response, or `0` when the call never completed. */
  status: number;
  /** Wall-clock duration of the replay in ms. */
  durationMs: number;
  /** The response body, capped at {@link REPLAY_BODY_CAP} bytes. */
  body: string;
  /** Present when the replay failed to complete (timeout / network error). */
  error?: string;
}

const REPLAY_TIMEOUT_MS = 30_000;
/** Max bytes of the replayed response body returned (4 KB). */
const REPLAY_BODY_CAP = 4096;
/** Headers stripped from the replayed request (auth/session/routing leakage). */
const REPLAY_STRIPPED_HEADERS = new Set(['cookie', 'authorization', 'host', 'content-length']);

/**
 * Re-issue a captured request against the LOCAL server (127.0.0.1:<port>) so a
 * developer can reproduce it from the dashboard. The replay carries a
 * `x-telescope-replay: 1` header (so the host can recognize/skip it) and strips
 * cookie/authorization/host headers — a replay must not silently reuse the
 * original caller's credentials. Bounded by a 30s timeout; the body is capped at
 * 4 KB. Never throws — a failed call returns `status: 0` with an `error`.
 */
export async function replayRequest(
  content: RequestContent,
  request: unknown,
): Promise<ReplayResult> {
  const port = resolveLocalPort(request);
  const path = content.uri.startsWith('/') ? content.uri : `/${content.uri}`;
  const url = `http://127.0.0.1:${port}${path}`;
  const headers = buildReplayHeaders(content.headers);
  const method = (content.method || 'GET').toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD' && content.payload != null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPLAY_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method,
      headers,
      ...(hasBody ? { body: serializePayload(content.payload, headers) } : {}),
      signal: controller.signal,
      redirect: 'manual',
    });
    const text = await response.text();
    return {
      status: response.status,
      durationMs: Date.now() - startedAt,
      body: text.slice(0, REPLAY_BODY_CAP),
    };
  } catch (error: unknown) {
    return {
      status: 0,
      durationMs: Date.now() - startedAt,
      body: '',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Copy headers minus the stripped set, and force `x-telescope-replay: 1`. */
function buildReplayHeaders(source: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (REPLAY_STRIPPED_HEADERS.has(key.toLowerCase())) continue;
    if (typeof value === 'string') headers[key] = value;
    else if (Array.isArray(value) && typeof value[0] === 'string') headers[key] = value[0];
  }
  headers['x-telescope-replay'] = '1';
  return headers;
}

/** Serialize a captured payload to a fetch body, defaulting to JSON. */
function serializePayload(payload: unknown, headers: Record<string, string>): string {
  if (typeof payload === 'string') return payload;
  const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
  if (!hasContentType) headers['content-type'] = 'application/json';
  return JSON.stringify(payload);
}

/** Resolve the local server port from the incoming request's socket/host header. */
function resolveLocalPort(request: unknown): number {
  if (typeof request === 'object' && request !== null) {
    const socket = (request as { socket?: { localPort?: unknown } }).socket;
    if (socket && typeof socket.localPort === 'number' && socket.localPort > 0) {
      return socket.localPort;
    }
    const headers = (request as { headers?: Record<string, unknown> }).headers;
    const host = headers?.host;
    if (typeof host === 'string') {
      const portPart = host.split(':')[1];
      const parsed = portPart !== undefined ? Number(portPart) : Number.NaN;
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  // Fall back to PORT env or the conventional 3000.
  const envPort = Number(process.env.PORT);
  return Number.isFinite(envPort) && envPort > 0 ? envPort : 3000;
}
