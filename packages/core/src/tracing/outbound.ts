// packages/core/src/tracing/outbound.ts
//
// Outgoing propagation: `traceparent` (and the caller's `tracestate`) on the calls this app makes
// to the configured targets.
//
// Hooked on the `diagnostics_channel` undici publishes for every request it creates (every
// `fetch`, whatever dispatcher the app installed, a `ProxyAgent` set after boot included), the same
// hook OpenTelemetry's undici instrumentation uses. `node:http` has its own channel, used only with
// `nodeHttp: true`.
//
// Never injects twice: a request that already carries `traceparent` (set by the app, or by
// OpenTelemetry) is left alone, and while an OpenTelemetry propagator is registered telescope
// leaves propagation to it entirely.
import diagnostics_channel from 'node:diagnostics_channel';
import { isOtelPropagationActive, isTelescopeWork } from '../otel/telescope-runtime.js';
import {
  type ResolvedPropagation,
  isPropagationTarget,
  originOf,
  propagatesOutbound,
} from './config.js';
import { outgoingTraceHeaders } from './runtime.js';

/** undici publishes this when it creates a request (Node's bundled `fetch` included). */
export const UNDICI_REQUEST_CREATE = 'undici:request:create';
/** Node publishes this when an `http.request` / `https.request` is created, before it is sent. */
export const HTTP_CLIENT_REQUEST_CREATED = 'http.client.request.created';

interface UndiciRequestLike {
  origin?: unknown;
  headers?: unknown;
  addHeader?(name: string, value: string): unknown;
}

interface ClientRequestLike {
  protocol?: unknown;
  host?: unknown;
  headersSent?: boolean;
  getHeader?(name: string): unknown;
  setHeader?(name: string, value: string): unknown;
}

function undiciHasTraceparent(headers: unknown): boolean {
  if (typeof headers === 'string') return /(^|\r\n)traceparent:/i.test(headers);
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) {
      if (String(headers[i]).toLowerCase() === 'traceparent') return true;
    }
  }
  return false;
}

function undiciOrigin(request: UndiciRequestLike): string | null {
  const origin = request.origin;
  if (typeof origin === 'string') return originOf(origin);
  if (origin instanceof URL) return originOf(origin.href);
  return null;
}

function clientRequestOrigin(request: ClientRequestLike): string | null {
  const protocol = typeof request.protocol === 'string' ? request.protocol : 'http:';
  const hostHeader = request.getHeader?.('host');
  const host =
    typeof hostHeader === 'string'
      ? hostHeader
      : typeof request.host === 'string'
        ? request.host
        : '';
  if (host === '') return null;
  return originOf(`${protocol}//${host}`);
}

/** The headers for a call to `origin`, or `null` when it carries none. */
function headersFor(config: ResolvedPropagation, origin: string | null) {
  if (isTelescopeWork()) return null;
  // Process-wide rather than per active span: OpenTelemetry's undici instrumentation injects even
  // outside a span, so stepping aside only inside one would send two headers outside it.
  if (isOtelPropagationActive()) return null;
  if (!isPropagationTarget(config.targets, origin)) return null;
  return outgoingTraceHeaders();
}

/** Inject into one undici request. Exported for tests. */
export function injectIntoUndiciRequest(
  config: ResolvedPropagation,
  request: UndiciRequestLike,
): void {
  if (typeof request.addHeader !== 'function') return;
  if (undiciHasTraceparent(request.headers)) return;
  const headers = headersFor(config, undiciOrigin(request));
  if (headers === null) return;
  request.addHeader('traceparent', headers.traceparent);
  if (headers.tracestate !== undefined) request.addHeader('tracestate', headers.tracestate);
}

/** Inject into one `node:http` request. Exported for tests. */
export function injectIntoClientRequest(
  config: ResolvedPropagation,
  request: ClientRequestLike,
): void {
  if (typeof request.setHeader !== 'function' || request.headersSent === true) return;
  if (request.getHeader?.('traceparent') !== undefined) return;
  const headers = headersFor(config, clientRequestOrigin(request));
  if (headers === null) return;
  request.setHeader('traceparent', headers.traceparent);
  if (headers.tracestate !== undefined) request.setHeader('tracestate', headers.tracestate);
}

const INSTALLED = Symbol.for('@dudousxd/nestjs-telescope:outbound-propagation');
type Installed = { undici: (msg: unknown) => void; http: ((msg: unknown) => void) | null };
const slot = globalThis as Record<symbol, unknown>;

/** Stop adding trace headers to outgoing calls. */
export function uninstallOutboundPropagation(): void {
  const installed = slot[INSTALLED] as Installed | undefined;
  if (installed === undefined) return;
  diagnostics_channel.unsubscribe(UNDICI_REQUEST_CREATE, installed.undici);
  if (installed.http !== null) {
    diagnostics_channel.unsubscribe(HTTP_CLIENT_REQUEST_CREATED, installed.http);
  }
  slot[INSTALLED] = undefined;
}

/**
 * Start adding trace headers to outgoing calls (replacing a previous install). Returns the
 * function that stops it. A no-op when there are no `targets`.
 */
export function installOutboundPropagation(config: ResolvedPropagation): () => void {
  uninstallOutboundPropagation();
  if (!propagatesOutbound(config)) return () => {};
  const undici = (message: unknown) => {
    try {
      const request = (message as { request?: UndiciRequestLike } | null)?.request;
      if (request) injectIntoUndiciRequest(config, request);
    } catch {
      // Propagation never breaks the call.
    }
  };
  diagnostics_channel.subscribe(UNDICI_REQUEST_CREATE, undici);
  let http: Installed['http'] = null;
  if (config.nodeHttp) {
    http = (message: unknown) => {
      try {
        const request = (message as { request?: ClientRequestLike } | null)?.request;
        if (request) injectIntoClientRequest(config, request);
      } catch {
        // Propagation never breaks the call.
      }
    };
    diagnostics_channel.subscribe(HTTP_CLIENT_REQUEST_CREATED, http);
  }
  const installed: Installed = { undici, http };
  slot[INSTALLED] = installed;
  return () => {
    if (slot[INSTALLED] === installed) uninstallOutboundPropagation();
  };
}
