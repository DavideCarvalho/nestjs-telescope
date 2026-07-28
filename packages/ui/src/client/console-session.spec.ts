import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConsoleSessionError,
  mintTelescopeConsoleSession,
  openTelescopeConsole,
  telescopeConsoleSessionUrl,
  telescopeConsoleUrl,
} from './console-session.js';

function response(init: { status?: number; type?: string } = {}): Response {
  const status = init.status ?? 204;
  return {
    ok: status >= 200 && status < 300,
    status,
    type: init.type ?? 'basic',
  } as Response;
}

/**
 * The first `fetch` call's arguments, asserted present. Under `noUncheckedIndexedAccess` a bare
 * `mock.calls[0]` is possibly-undefined; failing loudly here also turns "the request was never
 * made" into a clear message instead of a destructuring TypeError.
 */
function firstCall(mock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  const call = mock.mock.calls[0];
  if (!call) throw new Error('fetch was never called');
  return call as [string, RequestInit];
}

describe('telescopeConsoleSessionUrl', () => {
  it('derives the mint path from the default mount', () => {
    expect(telescopeConsoleSessionUrl()).toBe('/telescope/api/auth/session');
    expect(telescopeConsoleUrl()).toBe('/telescope');
  });

  it('follows a custom basePath', () => {
    // A host that mounts elsewhere must not have to know the suffix — that is the whole reason
    // this is derived here rather than hardcoded at the call site.
    expect(telescopeConsoleSessionUrl('/ops/scope')).toBe('/ops/scope/api/auth/session');
    expect(telescopeConsoleUrl('/ops/scope')).toBe('/ops/scope');
  });

  it('tolerates a missing leading slash and a trailing one', () => {
    expect(telescopeConsoleSessionUrl('ops/')).toBe('/ops/api/auth/session');
    expect(telescopeConsoleUrl('ops/')).toBe('/ops');
  });
});

describe('mintTelescopeConsoleSession', () => {
  it('posts with credentials so the Set-Cookie sticks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    await mintTelescopeConsoleSession({ fetch: fetchMock });

    const [url, init] = firstCall(fetchMock);
    expect(url).toBe('/telescope/api/auth/session');
    expect(init.method).toBe('POST');
    // Without this the cookie is dropped and the navigation lands session-less.
    expect(init.credentials).toBe('include');
  });

  it('sends host headers, resolving a function at call time', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    // A function (not a captured value) is what a refreshing token needs.
    await mintTelescopeConsoleSession({
      fetch: fetchMock,
      headers: () => ({ Authorization: 'Bearer fresh-token' }),
    });

    expect(firstCall(fetchMock)[1].headers).toEqual({ Authorization: 'Bearer fresh-token' });
  });

  it('awaits an async headers function', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    await mintTelescopeConsoleSession({
      fetch: fetchMock,
      headers: async () => ({ Authorization: 'Bearer awaited' }),
    });

    expect(firstCall(fetchMock)[1].headers).toEqual({ Authorization: 'Bearer awaited' });
  });

  it('throws with the status when the console refuses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ status: 401 }));

    await expect(mintTelescopeConsoleSession({ fetch: fetchMock })).rejects.toBeInstanceOf(
      ConsoleSessionError,
    );
    await expect(mintTelescopeConsoleSession({ fetch: fetchMock })).rejects.toMatchObject({
      status: 401,
      url: '/telescope/api/auth/session',
    });
  });

  it('does not follow redirects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    await mintTelescopeConsoleSession({ fetch: fetchMock });

    // `fetch` follows redirects by default; that default is what turns an intercepted 401 into a
    // silent success against someone else's HTML.
    expect(firstCall(fetchMock)[1].redirect).toBe('manual');
  });

  it('reports a browser opaque redirect as an interception, not a success', async () => {
    // Browsers answer `redirect: 'manual'` with an opaque response: status 0, `ok: false`. Without
    // the explicit check the generic "HTTP 0" message would say nothing about the real cause.
    const fetchMock = vi.fn().mockResolvedValue(response({ status: 0, type: 'opaqueredirect' }));

    await expect(mintTelescopeConsoleSession({ fetch: fetchMock })).rejects.toThrow(
      /answered with a redirect/,
    );
  });

  it('reports a Node/undici 3xx as the same interception', async () => {
    // Same failure, different runtime: undici surfaces the real status instead of an opaque type.
    const fetchMock = vi.fn().mockResolvedValue(response({ status: 302 }));

    await expect(mintTelescopeConsoleSession({ fetch: fetchMock })).rejects.toThrow(
      /answered with a redirect/,
    );
  });

  it('wraps a network failure rather than leaking the raw rejection', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(mintTelescopeConsoleSession({ fetch: fetchMock })).rejects.toBeInstanceOf(
      ConsoleSessionError,
    );
  });
});

describe('openTelescopeConsole', () => {
  const navigate = vi.fn();

  beforeEach(() => {
    navigate.mockClear();
  });

  it('navigates to the console after a successful mint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    await openTelescopeConsole({ fetch: fetchMock, navigate });

    expect(navigate).toHaveBeenCalledWith('/telescope');
  });

  it('navigates to the custom mount', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    await openTelescopeConsole({ fetch: fetchMock, navigate, basePath: '/ops/scope' });

    expect(navigate).toHaveBeenCalledWith('/ops/scope');
  });

  it('does NOT navigate when the mint is refused', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ status: 403 }));

    await expect(openTelescopeConsole({ fetch: fetchMock, navigate })).rejects.toBeInstanceOf(
      ConsoleSessionError,
    );
    // Navigating anyway would drop the user on the console's "no session" page, which reads as a
    // broken console rather than a permission decision.
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does NOT navigate when the response was an intercepted redirect', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ status: 0, type: 'opaqueredirect' }));

    await expect(openTelescopeConsole({ fetch: fetchMock, navigate })).rejects.toThrow(
      /answered with a redirect/,
    );
    expect(navigate).not.toHaveBeenCalled();
  });
});
