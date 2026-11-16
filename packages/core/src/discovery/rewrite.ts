// packages/core/src/discovery/rewrite.ts
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { isTelescopeWork, runAsTelescopeWork } from '../otel/telescope-runtime.js';
import type { ServiceDirectory } from './directory.js';

/**
 * `fetch('http://billing/invoices/1')` → `https://billing.internal/invoices/1`.
 *
 * Only single-label hosts that name a known app are rewritten; a host with a dot, an IP, and a
 * single-label host that names no app (a Docker Compose service such as `minio`) go out as
 * written. With `strict`, a single-label host that names no app and is not in `passthrough` fails
 * the call with "app billing is not registered" instead of reaching DNS.
 *
 * The rewrite runs in a dispatcher composed onto the global one, outermost, so every interceptor
 * after it sees the real origin, and so do the trace headers, added when undici creates the
 * request.
 */

/** Why a call to an app name failed. */
export class DiscoveryError extends Error {
  constructor(
    message: string,
    readonly app: string,
  ) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

/** What the rewrite needs besides the directory. */
export interface RewriteOptions {
  passthrough: Set<string>;
  failFast: boolean;
  /** Fail calls to single-label hosts that name no app (and are not in `passthrough`). */
  strict?: boolean;
}

/** Where a call to `origin` goes instead: the new origin and a base path to prefix. */
export interface RewriteTarget {
  origin: string;
  basePath: string;
  app: string;
}

/** Whether `hostname` is an app name candidate: one DNS label, not an IP, not passed through. */
export function isAppHost(hostname: string, passthrough: Set<string>): boolean {
  const host = hostname.toLowerCase();
  if (host === '' || host.includes('.') || host.includes(':') || host.startsWith('[')) return false;
  if (/^\d+$/.test(host)) return false;
  return !passthrough.has(host);
}

/**
 * Where a call to `url` (an origin or a full URL) goes: `null` to leave it alone, a target to
 * rewrite it. Throws {@link DiscoveryError} for an app name nothing resolves.
 */
export function rewriteTarget(
  directory: ServiceDirectory,
  options: RewriteOptions,
  url: string | URL,
): RewriteTarget | null {
  let parsed: URL;
  try {
    parsed = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!isAppHost(parsed.hostname, options.passthrough)) return null;
  const app = parsed.hostname.toLowerCase();
  const found = directory.lookup(app);
  if (found.kind === 'unknown') {
    // Not an app: by default the host goes out as written (a Compose service, say).
    if (options.strict !== true) return null;
    throw new DiscoveryError(
      `telescope: app ${app} is not registered: no app named "${app}" in discovery.apps or on the control plane. Add it to discovery.apps, or to discovery.passthrough if "${app}" is a host, not an app (discovery.strict is on).`,
      app,
    );
  }
  if (found.kind === 'down' && options.failFast) {
    throw new DiscoveryError(
      `telescope: app ${app} has no live instance (discovery.failFast is on).`,
      app,
    );
  }
  const target = new URL(found.url);
  return { origin: target.origin, basePath: target.pathname.replace(/\/+$/, ''), app };
}

/** The slice of undici's dispatch options the interceptor rewrites. */
interface DispatchOptions {
  origin?: string | URL;
  path?: string;
  [key: string]: unknown;
}

type Dispatch = (options: DispatchOptions, handler: unknown) => unknown;

/** The origin the start-time self-check calls: reserved (`.invalid`), answered by the interceptor. */
export const PROBE_ORIGIN = 'http://telescope-discovery-probe.invalid';

/** What the interceptor fails a probe with: proof that `fetch` went through it. */
export class DiscoveryProbeAnswer extends Error {
  constructor() {
    super('telescope discovery probe');
    this.name = 'DiscoveryProbeAnswer';
  }
}

/** The slice of an undici dispatch handler used to fail a request (undici 7 and 8). */
interface FailableHandler {
  onResponseError?: (controller: unknown, error: unknown) => void;
  onError?: (error: unknown) => void;
}

/**
 * Fail a request from inside an interceptor. undici 8's `compose` passes the caller's handler
 * through unwrapped (`onResponseError`), undici 7 wraps it (`onError`).
 */
function failRequest(handler: unknown, error: unknown): boolean {
  const h = handler as FailableHandler;
  if (typeof h.onResponseError === 'function') h.onResponseError(null, error);
  else h.onError?.(error);
  return true;
}

/**
 * The undici interceptor (`dispatcher.compose(...)`): rewrites the origin of app-name calls.
 * Idempotent: a request that passes through it twice (Node composes `.1` and `.2`) is rewritten
 * once, the second pass sees a real origin.
 */
export function discoveryInterceptor(
  directory: ServiceDirectory,
  options: RewriteOptions,
  state: { active: boolean } = { active: true },
) {
  return (dispatch: Dispatch): Dispatch =>
    function discoveryDispatch(opts, handler) {
      // Uninstalled while something else sat on top of it: a pass-through from then on.
      if (!state.active || opts.origin === undefined) return dispatch(opts, handler);
      const origin = String(opts.origin);
      if (origin.replace(/\/+$/, '') === PROBE_ORIGIN) {
        return failRequest(handler, new DiscoveryProbeAnswer());
      }
      if (isTelescopeWork()) return dispatch(opts, handler);
      let target: RewriteTarget | null;
      try {
        target = rewriteTarget(directory, options, origin);
      } catch (error) {
        return failRequest(handler, error);
      }
      if (target === null) return dispatch(opts, handler);
      return dispatch(
        { ...opts, origin: target.origin, path: `${target.basePath}${opts.path ?? '/'}` },
        handler,
      );
    };
}

/**
 * Node keeps `fetch`'s dispatcher in a global slot: `.1` on Node 24 (undici 7), `.2` on Node 26
 * (undici 8, where `.1` is a legacy wrapper `fetch` never reads). Both may exist; the rewrite is
 * composed onto each one that does.
 */
const DISPATCHER_SLOTS = [
  Symbol.for('undici.globalDispatcher.2'),
  Symbol.for('undici.globalDispatcher.1'),
] as const;
const slot = globalThis as Record<symbol, unknown>;

interface ComposableDispatcher {
  compose(...interceptors: unknown[]): unknown;
}

function isComposable(value: unknown): value is ComposableDispatcher {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { compose?: unknown }).compose === 'function'
  );
}

/**
 * Node's bundled undici installs the dispatcher on the first `fetch()` call (and, when it finds no
 * `.2`, overwrites `.1`). A `data:` fetch makes it load without touching the network, so the
 * rewrite is composed onto the dispatcher `fetch` actually uses, and is not overwritten later.
 */
async function ensureGlobalDispatcher(): Promise<void> {
  if (slot[DISPATCHER_SLOTS[0]] !== undefined) return;
  await runAsTelescopeWork(() => fetch('data:,').catch(() => undefined));
}

/** The installed rewrite: re-asserts itself outermost, checks itself, and uninstalls. */
export interface InstalledRewrite {
  /** Compose again on top where something composed onto (or replaced) a dispatcher since. */
  reassert(): void;
  /** Whether `fetch` really goes through the rewrite (a probe answered locally, no network). */
  selfCheck(): Promise<boolean>;
  uninstall(): void;
}

/** Whether `fetch` goes through the rewrite: the probe origin fails with the probe answer. */
export async function probeFetchRewrite(): Promise<boolean> {
  try {
    await fetch(`${PROBE_ORIGIN}/`, { signal: AbortSignal.timeout(2000) });
    return false;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error && cause.name === 'DiscoveryProbeAnswer';
  }
}

/**
 * Compose the rewrite onto Node's global dispatcher(s), outermost. Never replaces a dispatcher with
 * a new one: it composes onto the current one, so other libraries' interceptors stay in place.
 */
export async function installFetchRewrite(
  directory: ServiceDirectory,
  options: RewriteOptions,
): Promise<InstalledRewrite | null> {
  await ensureGlobalDispatcher();
  const state = { active: true };
  const interceptor = discoveryInterceptor(directory, options, state);
  const installed = new Map<symbol, { original: unknown; ours: unknown }>();
  for (const key of DISPATCHER_SLOTS) {
    const current = slot[key];
    if (!isComposable(current)) continue;
    const ours = current.compose(interceptor);
    slot[key] = ours;
    installed.set(key, { original: current, ours });
  }
  if (installed.size === 0) return null;
  return {
    reassert() {
      for (const key of DISPATCHER_SLOTS) {
        const current = slot[key];
        const entry = installed.get(key);
        if (!isComposable(current) || current === entry?.ours) continue;
        // Someone composed on top of us: go back on top. The rewrite further in is then a no-op,
        // the origin is no longer an app name.
        const ours = current.compose(interceptor);
        slot[key] = ours;
        installed.set(key, { original: entry?.original ?? current, ours });
      }
    },
    selfCheck: probeFetchRewrite,
    uninstall() {
      state.active = false;
      for (const [key, entry] of installed) {
        if (slot[key] === entry.ours) slot[key] = entry.original;
      }
    },
  };
}

type RequestFn = typeof http.request;

/** The URL a `http.request(...)` call targets, from its loose arguments. */
function requestUrl(protocol: string, args: unknown[]): { url: URL; rest: unknown[] } | null {
  const [first, ...rest] = args;
  if (typeof first === 'string' || first instanceof URL) {
    try {
      return { url: new URL(String(first)), rest };
    } catch {
      return null;
    }
  }
  if (first !== null && typeof first === 'object') {
    const o = first as {
      protocol?: string;
      hostname?: string;
      host?: string;
      port?: number | string;
      path?: string;
    };
    const host = o.hostname ?? o.host?.replace(/:\d+$/, '');
    if (typeof host !== 'string') return null;
    try {
      const url = new URL(`${o.protocol ?? protocol}//${host}`);
      if (o.port !== undefined) url.port = String(o.port);
      return { url, rest: [first, ...rest] };
    } catch {
      return null;
    }
  }
  return null;
}

/** `http.request` arguments whose host lookup fails with `error` (an `error` event, no DNS). */
function withLookupError(args: unknown[], error: unknown): unknown[] {
  const lookup = (_host: string, _options: unknown, callback: (error: unknown) => void) => {
    process.nextTick(() => callback(error));
  };
  const [first, ...rest] = args;
  if (typeof first === 'string' || first instanceof URL) {
    const hasOptions = rest[0] !== null && typeof rest[0] === 'object';
    return hasOptions
      ? [first, { ...(rest[0] as object), lookup }, ...rest.slice(1)]
      : [first, { lookup }, ...rest];
  }
  return [{ ...(first as object), lookup }, ...rest];
}

/** Patch `http.request/get` and `https.request/get` to resolve app names. Returns the unpatch. */
export function installNodeHttpRewrite(
  directory: ServiceDirectory,
  options: RewriteOptions,
): () => void {
  const originals = {
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
  };

  const wrap = (protocol: 'http:' | 'https:', get: boolean): RequestFn =>
    function discoveryRequest(this: unknown, ...args: unknown[]) {
      const call = (proto: 'http:' | 'https:', callArgs: unknown[]) => {
        const fn =
          proto === 'https:'
            ? get
              ? originals.httpsGet
              : originals.httpsRequest
            : get
              ? originals.httpGet
              : originals.httpRequest;
        return (fn as (...a: unknown[]) => unknown)(...callArgs);
      };
      if (isTelescopeWork()) return call(protocol, args);
      const parsed = requestUrl(protocol, args);
      let target: RewriteTarget | null;
      try {
        target = parsed === null ? null : rewriteTarget(directory, options, parsed.url);
      } catch (error) {
        // Fail the way Node's http fails: an `error` event on the returned request, not a throw.
        // The lookup fails with the discovery error, so the bogus name never reaches DNS.
        return call(protocol, withLookupError(args, error));
      }
      if (parsed === null || target === null) return call(protocol, args);
      const to = new URL(target.origin);
      const proto = to.protocol as 'http:' | 'https:';
      const [first, ...rest] = args;
      let requestOptions: Record<string, unknown>;
      let tail: unknown[];
      if (typeof first === 'string' || first instanceof URL) {
        const url = parsed.url;
        // `request(url, [options], [callback])`.
        const hasOptions = rest[0] !== null && typeof rest[0] === 'object';
        const extra = hasOptions ? (rest[0] as Record<string, unknown>) : {};
        tail = hasOptions ? rest.slice(1) : rest;
        requestOptions = { ...extra, path: `${url.pathname}${url.search}` };
      } else {
        requestOptions = { ...(first as Record<string, unknown>) };
        tail = rest;
      }
      const path = typeof requestOptions.path === 'string' ? requestOptions.path : '/';
      // `host` would win over `hostname`; an agent belongs to one protocol, so it is dropped when
      // the call switches.
      const { host: _host, agent, ...kept } = requestOptions;
      const next: Record<string, unknown> = {
        ...kept,
        ...(proto === protocol && agent !== undefined ? { agent } : {}),
        protocol: proto,
        hostname: to.hostname,
        port: to.port === '' ? undefined : Number(to.port),
        path: `${target.basePath}${path}`,
      };
      return call(proto, [next, ...tail]);
    } as unknown as RequestFn;

  http.request = wrap('http:', false);
  http.get = wrap('http:', true) as typeof http.get;
  https.request = wrap('https:', false);
  https.get = wrap('https:', true) as typeof https.get;
  syncBuiltinESMExports();
  return () => {
    http.request = originals.httpRequest;
    http.get = originals.httpGet;
    https.request = originals.httpsRequest;
    https.get = originals.httpsGet;
    syncBuiltinESMExports();
  };
}
