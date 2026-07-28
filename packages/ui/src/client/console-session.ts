/**
 * Headless client for opening the console from YOUR app.
 *
 * The console SPA is served at a literal path and knows nothing about your app's auth, so a plain
 * browser navigation to it carries no identity. Mode A closes that gap: an XHR from inside your app
 * — which DOES carry your auth — posts to the console's session endpoint, the `session` hook
 * decides, and the library answers with its own signed cookie. The navigation that follows rides it.
 *
 * Telescope's mount is configured as `path` (no leading slash, e.g. `'telescope'`); this accepts either
 * form and normalizes it.
 *
 * No UI here on purpose: you own the button, the page and the copy. This module owns the two things
 * a host would otherwise have to rediscover — where the session endpoint actually lives, and how to
 * call it without the failure mode below.
 */

/** The mount default; matches `TelescopeUiModule.forRoot()`'s own default. */
const DEFAULT_BASE_PATH = '/telescope';

function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.trim().replace(/\/+$/, '');
  if (trimmed === '') return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/**
 * Where `POST` mints the console session cookie.
 *
 * Derived from `basePath` rather than hardcoded by the caller: this package owns the route (the auth
 * controller lives under the configured mount), so a host that hardcodes it
 * is guessing at something that can change under a version bump — with no compile error when it
 * does, because the break only shows up as a 404 at runtime.
 */
export function telescopeConsoleSessionUrl(basePath: string = DEFAULT_BASE_PATH): string {
  return `${normalizeBasePath(basePath)}/api/auth/session`;
}

/** Where the console SPA itself is served. */
export function telescopeConsoleUrl(basePath: string = DEFAULT_BASE_PATH): string {
  return normalizeBasePath(basePath) || '/';
}

export interface OpenConsoleOptions {
  /** Where the console is mounted. MUST match `TelescopeUiModule.forRoot({ path }) / TelescopeModule.forRoot({ path })`. */
  basePath?: string;
  /**
   * Headers for the mint request — in practice your app's `Authorization` header. A function (sync
   * or async) is accepted so a token can be read at call time rather than captured at wiring time,
   * which is what a refreshing token needs.
   */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  /** Injected for tests and non-browser callers. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  /**
   * Performs the navigation after a successful mint. Defaults to `location.assign`. Override to
   * route through your own router, or to open in a new tab.
   */
  navigate?: (url: string) => void;
}

/** Thrown when the session could not be minted. Never thrown after a successful mint. */
export class ConsoleSessionError extends Error {
  constructor(
    message: string,
    readonly url: string,
    /** The HTTP status, or `undefined` when the request never produced one (network error). */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ConsoleSessionError';
  }
}

async function resolveHeaders(headers: OpenConsoleOptions['headers']): Promise<HeadersInit> {
  if (headers === undefined) return {};
  return typeof headers === 'function' ? await headers() : headers;
}

/**
 * Mint the console session cookie. Resolves on success; throws {@link ConsoleSessionError} on
 * refusal. Use this directly when you want to mint without navigating (a pre-flight check, or a
 * link the user opens later).
 */
export async function mintTelescopeConsoleSession(options: OpenConsoleOptions = {}): Promise<void> {
  const url = telescopeConsoleSessionUrl(options.basePath);
  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new ConsoleSessionError('No `fetch` available; pass one via `options.fetch`.', url);
  }

  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      // The whole point: the response's Set-Cookie must stick, and the cookie must ride the
      // navigation that follows.
      credentials: 'include',
      headers: await resolveHeaders(options.headers),
      // Load-bearing, and the reason this helper exists rather than three lines at the call site.
      // `fetch` FOLLOWS redirects by default, so an app whose auth layer rewrites a 401 into a
      // "go to /signin" redirect makes this request resolve 200 against the sign-in HTML —
      // `response.ok` reads true, the caller navigates, and the user lands in a console with no
      // session, which looks exactly like a permissions bug. Handling the redirect explicitly turns
      // that into a clear error instead of a silent false success.
      redirect: 'manual',
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    throw new ConsoleSessionError(
      `Could not reach the console session endpoint at ${url}: ${String(cause)}`,
      url,
    );
  }

  // `redirect: 'manual'` surfaces differently per runtime: browsers give an opaque response
  // (`type: 'opaqueredirect'`, status 0), Node/undici gives the real 3xx. Both mean the same thing.
  const redirected =
    response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
  if (redirected) {
    throw new ConsoleSessionError(
      `The console session endpoint at ${url} answered with a redirect instead of minting a session. Something in front of it — usually an auth middleware or exception filter that rewrites 401s into a sign-in redirect — is intercepting the response. Exempt this path from that rewrite so the real status reaches this caller.`,
      url,
      response.status || undefined,
    );
  }

  if (!response.ok) {
    throw new ConsoleSessionError(
      `The console refused to open (HTTP ${response.status}).`,
      url,
      response.status,
    );
  }
}

/**
 * Mint the session, then navigate to the console. Throws without navigating when the mint is
 * refused, so a denied user gets a real error instead of landing on the console's
 * "no session" page — which reads as a bug rather than a permission decision.
 */
export async function openTelescopeConsole(options: OpenConsoleOptions = {}): Promise<void> {
  await mintTelescopeConsoleSession(options);
  const target = telescopeConsoleUrl(options.basePath);
  const navigate = options.navigate ?? ((url: string) => globalThis.location?.assign(url));
  navigate(target);
}
