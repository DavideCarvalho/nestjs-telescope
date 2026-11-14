import { afterEach, describe, expect, it, vi } from 'vitest';
import { LAST_PAGE_META } from '../testing/mock-telescope-client.js';
import { createTelescopeClient } from './telescope-client.js';

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function statusResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe('createTelescopeClient default base URL', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to /telescope/api when the global base is absent', async () => {
    vi.stubGlobal('window', undefined);
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    const client = createTelescopeClient({ fetch: fetchMock });
    await client.meta();
    expect(fetchMock.mock.calls[0]![0] as string).toBe('/telescope/api/meta');
  });

  it('derives the base from window.__TELESCOPE_BASE__ when present', async () => {
    vi.stubGlobal('window', { __TELESCOPE_BASE__: '/observability' });
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    const client = createTelescopeClient({ fetch: fetchMock });
    await client.meta();
    expect(fetchMock.mock.calls[0]![0] as string).toBe('/observability/api/meta');
  });

  it('lets an explicit baseUrl win over the injected global', async () => {
    vi.stubGlobal('window', { __TELESCOPE_BASE__: '/observability' });
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    const client = createTelescopeClient({ baseUrl: '/custom/api', fetch: fetchMock });
    await client.meta();
    expect(fetchMock.mock.calls[0]![0] as string).toBe('/custom/api/meta');
  });
});

describe('createTelescopeClient', () => {
  it('lists entries with filter[type] + after/first query params', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ data: [], meta: LAST_PAGE_META }),
    );
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await client.entries({ type: 'query', after: 'abc', first: 10 });
    const url = new URL(fetchMock.mock.calls[0]![0] as string, 'http://x');
    expect(url.pathname).toBe('/telescope/api/entries');
    expect(url.searchParams.get('filter[type]')).toBe('query');
    expect(url.searchParams.get('after')).toBe('abc');
    expect(url.searchParams.get('first')).toBe('10');
    expect(url.searchParams.has('cursor')).toBe(false);
    expect(url.searchParams.has('limit')).toBe(false);
  });

  it('fetches a single entry (with its batch)', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ id: 'x', batch: [] }),
    );
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    const entry = await client.entry('x');
    expect(fetchMock.mock.calls[0]![0] as string).toBe('/telescope/api/entries/x');
    expect(entry).toMatchObject({ id: 'x' });
  });

  it('fetches extension panel data and encodes the ext + provider path', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ value: 1 }));
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await client.extData('my ext', 'top/providers');
    expect(fetchMock.mock.calls[0]![0] as string).toBe(
      '/telescope/api/ext/my%20ext/data/top%2Fproviders',
    );
  });

  it('serializes the panel data query into the query string', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ value: 1 }));
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await client.extData('billing', 'revenue', { window: '24h', limit: 5 });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/telescope/api/ext/billing/data/revenue?');
    expect(url).toContain('window=24h');
    expect(url).toContain('limit=5');
  });

  it('omits the query string when no panel query is given', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ value: 1 }));
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await client.extData('billing', 'revenue', {});
    expect(fetchMock.mock.calls[0]![0] as string).toBe('/telescope/api/ext/billing/data/revenue');
  });

  it('posts a confirmed extension action and surfaces the server message on failure', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ ok: true, result: { state: 'closed' } }),
    );
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await expect(
      client.extAction?.('resilience', 'reset-circuit', { name: 'a b' }),
    ).resolves.toEqual({ ok: true, result: { state: 'closed' } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/telescope/api/ext/resilience/actions/reset-circuit');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ confirmed: true, input: { name: 'a b' } });

    fetchMock.mockResolvedValueOnce(statusResponse(404, { message: 'No circuit breaker "x".' }));
    await expect(client.extAction?.('resilience', 'reset-circuit', { name: 'x' })).rejects.toThrow(
      'No circuit breaker "x".',
    );
  });

  it('fetches pulse and queues with a window param', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await client.pulse('15m');
    await client.queues('1h');
    expect(fetchMock.mock.calls[0]![0] as string).toBe('/telescope/api/pulse?window=15m');
    expect(fetchMock.mock.calls[1]![0] as string).toBe('/telescope/api/queues?window=1h');
  });

  it('returns the parsed pulse body', async () => {
    const body = {
      counts: { query: 2 },
      slowest: [],
      topExceptions: [],
      nPlusOne: [],
      windowMs: 3600000,
      windowStart: '',
      windowEnd: '',
      scanned: 0,
      truncated: false,
    };
    const fetchMock = vi.fn<typeof globalThis.fetch>(
      async () => ({ ok: true, status: 200, json: async () => body }) as Response,
    );
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    expect(await client.pulse('1h')).toEqual(body);
  });

  it('fetches timeseries with window + buckets', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(
      async () => ({ ok: true, status: 200, json: async () => ({ buckets: [] }) }) as Response,
    );
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await client.timeseries({ window: '1h', buckets: 60 });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/timeseries?');
    expect(url).toContain('window=1h');
    expect(url).toContain('buckets=60');
  });

  it('fetches stats with type + window', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(
      async () => ({ ok: true, status: 200, json: async () => ({ overTime: {} }) }) as Response,
    );
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await client.stats('query', '1h');
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/stats?');
    expect(url).toContain('type=query');
    expect(url).toContain('window=1h');
  });

  it('lists tags with an optional prefix', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse([{ tag: 'slow', count: 42 }]),
    );
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await client.tags('sl');
    expect(fetchMock.mock.calls[0]![0] as string).toBe(
      `/telescope/api/tags?${new URLSearchParams({ 'filter[tag][startsWith]': 'sl' })}`,
    );
  });

  it('omits the prefix param when listing all tags', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse([]));
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await client.tags();
    expect(fetchMock.mock.calls[0]![0] as string).toBe('/telescope/api/tags');
  });

  it('GETs the server-stats snapshot', async () => {
    const snapshot = {
      uptimeSec: 10,
      memory: { rssMb: 100, heapUsedMb: 50, heapTotalMb: 80 },
      cpu: { userMs: 1, systemMs: 2 },
      eventLoopDelayMs: 1.5,
      instanceId: 'i-1',
    };
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(snapshot));
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    const result = await client.serverStats();
    expect(fetchMock.mock.calls[0]![0] as string).toBe('/telescope/api/server-stats');
    expect(result).toEqual(snapshot);
  });

  it('GETs the telescope health snapshot', async () => {
    const snapshot = {
      enabled: true,
      recorded: 100,
      bufferSize: 500,
      bufferUsed: 12,
      bufferHighWater: 80,
      flushes: 9,
      flushedEntries: 88,
      lastFlushMs: 1.2,
      maxFlushMs: 4.5,
      totalFlushMs: 20,
      overflowDropped: 0,
      storeFailedDropped: 0,
      droppedCount: 0,
      captureCostNanos: 8700,
    };
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(snapshot));
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    const result = await client.health();
    expect(fetchMock.mock.calls[0]![0] as string).toBe('/telescope/api/health');
    expect(result).toEqual(snapshot);
  });

  it('throws on a non-ok response', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(
      async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response,
    );
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await expect(client.meta()).rejects.toThrow();
  });

  it('GETs live queues', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ queues: [], capabilities: {} }),
    );
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await client.liveQueues();
    expect(fetchMock.mock.calls[0]![0] as string).toBe('/telescope/api/queues/live');
    expect(fetchMock.mock.calls[0]![1]).toBeUndefined();
  });

  it('GETs queue counts with encoded path segments', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await client.queueCounts('bullmq', 'a/b');
    expect(fetchMock.mock.calls[0]![0] as string).toBe(
      '/telescope/api/queues/live/bullmq/a%2Fb/counts',
    );
  });

  it('GETs queue jobs with filter[state] + after + first', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ data: [], meta: LAST_PAGE_META }),
    );
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await client.queueJobs('bullmq', 'q1', 'failed', { after: 'c1', first: 25 });
    const url = new URL(fetchMock.mock.calls[0]![0] as string, 'http://x');
    expect(url.pathname).toBe('/telescope/api/queues/live/bullmq/q1/jobs');
    expect(url.searchParams.get('filter[state]')).toBe('failed');
    expect(url.searchParams.get('after')).toBe('c1');
    expect(url.searchParams.get('first')).toBe('25');
  });

  it('GETs traces, profiles and the AI screen with size / first', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ data: [], meta: LAST_PAGE_META }),
    );
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await client.traces('1h', 20);
    await client.profiles({ first: 10, after: 'p' });
    await client.ai('1h', { size: 100 });
    const urls = fetchMock.mock.calls.map((call) => call[0] as string);
    expect(urls).toEqual([
      '/telescope/api/traces?window=1h&size=20',
      '/telescope/api/profiles?after=p&first=10',
      '/telescope/api/ai?window=1h&size=100',
    ]);
  });

  it('GETs a single live job', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(null));
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await client.queueJob('bullmq', 'q1', '99');
    expect(fetchMock.mock.calls[0]![0] as string).toBe(
      '/telescope/api/queues/live/bullmq/q1/jobs/99',
    );
  });

  it('POSTs a job action', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ ok: true }));
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await client.queueJobAction('bullmq', 'q1', '99', 'retry');
    expect(fetchMock.mock.calls[0]![0] as string).toBe(
      '/telescope/api/queues/live/bullmq/q1/jobs/99/retry',
    );
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
  });

  it('POSTs a bulk queue action with a state query param', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ ok: true, count: 4 }),
    );
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await client.queueAction('bullmq', 'q1', 'retry-all', { state: 'failed' });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/telescope/api/queues/live/bullmq/q1/actions/retry-all?');
    expect(url).toContain('state=failed');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
  });

  it('POSTs an enqueue with a JSON body (name + payload)', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ id: '7' }));
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    const result = await client.queueEnqueue('bullmq', 'q1', {
      name: 'send-email',
      payload: { to: 'a@b.c' },
    });
    expect(fetchMock.mock.calls[0]![0] as string).toBe(
      '/telescope/api/queues/live/bullmq/q1/enqueue',
    );
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'send-email',
      payload: { to: 'a@b.c' },
    });
    expect(result).toEqual({ id: '7' });
  });
});

describe('createTelescopeClient access denials', () => {
  function deniedResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('reports a 403 { error: forbidden } to onAccessDenied', async () => {
    const onAccessDenied = vi.fn();
    const client = createTelescopeClient({
      fetch: vi.fn(async () => deniedResponse(403, { error: 'forbidden' })),
      onAccessDenied,
    });
    await expect(client.meta()).rejects.toThrow(/403/);
    expect(onAccessDenied).toHaveBeenCalledWith({ status: 403, reason: 'forbidden' });
  });

  it('passes redirectTo from a 401', async () => {
    const onAccessDenied = vi.fn();
    const client = createTelescopeClient({
      fetch: vi.fn(async () =>
        deniedResponse(401, { error: 'unauthenticated', redirectTo: '/login' }),
      ),
      onAccessDenied,
    });
    await expect(client.meta()).rejects.toThrow(/401/);
    expect(onAccessDenied).toHaveBeenCalledWith({
      status: 401,
      reason: 'unauthenticated',
      redirectTo: '/login',
    });
  });

  it('ignores other 403s (e.g. mutations disabled)', async () => {
    const onAccessDenied = vi.fn();
    const client = createTelescopeClient({
      fetch: vi.fn(async () => deniedResponse(403, { message: 'Forbidden', statusCode: 403 })),
      onAccessDenied,
    });
    await expect(client.meta()).rejects.toThrow(/403/);
    expect(onAccessDenied).not.toHaveBeenCalled();
  });

  it('by default follows redirectTo with a full navigation', async () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      value: { ...original, assign },
      configurable: true,
    });
    try {
      const client = createTelescopeClient({
        fetch: vi.fn(async () =>
          deniedResponse(401, { error: 'unauthenticated', redirectTo: '/login' }),
        ),
      });
      await expect(client.meta()).rejects.toThrow();
      expect(assign).toHaveBeenCalledWith('/login');
    } finally {
      Object.defineProperty(window, 'location', { value: original, configurable: true });
    }
  });
});

describe('organization scope', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the page's ?tenant= on every call", async () => {
    vi.stubGlobal('window', { location: { search: '?tenant=org%201' } });
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ data: [] }));
    const client = createTelescopeClient({ baseUrl: '/t/api', fetch: fetchMock });
    await client.meta();
    await client.entries({ type: 'request' });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/t/api/meta?tenant=org%201',
      '/t/api/entries?filter%5Btype%5D=request&tenant=org%201',
    ]);
  });

  it('sends nothing without a tenant, and reads the scope from GET tenancy', async () => {
    vi.stubGlobal('window', { location: { search: '' } });
    const info = { enabled: true, tenants: ['A'], selected: 'A', options: [] };
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(info));
    const client = createTelescopeClient({ baseUrl: '/t/api', fetch: fetchMock });
    expect(await client.tenancy?.('ac')).toEqual(info);
    expect(fetchMock.mock.calls[0]![0]).toBe('/t/api/tenancy?search=ac');
  });

  it('an older server without GET tenancy (404) has no scope', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => statusResponse(404, {}));
    const client = createTelescopeClient({
      baseUrl: '/t/api',
      fetch: fetchMock,
      tenant: () => undefined,
    });
    expect(await client.tenancy?.()).toEqual({ enabled: false });
  });
});
