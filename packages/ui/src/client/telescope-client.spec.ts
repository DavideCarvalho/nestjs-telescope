import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTelescopeClient } from './telescope-client.js';

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe('createTelescopeClient default base URL', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to /telescope/api when the global base is absent', async () => {
    vi.stubGlobal('window', undefined);
    const fetchMock = vi.fn(async () => jsonResponse({}));
    const client = createTelescopeClient({ fetch: fetchMock });
    await client.meta();
    expect(fetchMock.mock.calls[0]![0] as string).toBe('/telescope/api/meta');
  });

  it('derives the base from window.__TELESCOPE_BASE__ when present', async () => {
    vi.stubGlobal('window', { __TELESCOPE_BASE__: '/observability' });
    const fetchMock = vi.fn(async () => jsonResponse({}));
    const client = createTelescopeClient({ fetch: fetchMock });
    await client.meta();
    expect(fetchMock.mock.calls[0]![0] as string).toBe('/observability/api/meta');
  });

  it('lets an explicit baseUrl win over the injected global', async () => {
    vi.stubGlobal('window', { __TELESCOPE_BASE__: '/observability' });
    const fetchMock = vi.fn(async () => jsonResponse({}));
    const client = createTelescopeClient({ baseUrl: '/custom/api', fetch: fetchMock });
    await client.meta();
    expect(fetchMock.mock.calls[0]![0] as string).toBe('/custom/api/meta');
  });
});

describe('createTelescopeClient', () => {
  it('lists entries with type + cursor query params', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [], nextCursor: null }));
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await client.entries({ type: 'query', cursor: 'abc', limit: 10 });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/telescope/api/entries?');
    expect(url).toContain('type=query');
    expect(url).toContain('cursor=abc');
    expect(url).toContain('limit=10');
  });

  it('fetches a single entry (with its batch)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 'x', batch: [] }));
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    const entry = await client.entry('x');
    expect(fetchMock.mock.calls[0]![0] as string).toBe('/telescope/api/entries/x');
    expect(entry).toMatchObject({ id: 'x' });
  });

  it('fetches pulse and queues with a window param', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
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
    const fetchMock = vi.fn(
      async () => ({ ok: true, status: 200, json: async () => body }) as Response,
    );
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    expect(await client.pulse('1h')).toEqual(body);
  });

  it('fetches timeseries with window + buckets', async () => {
    const fetchMock = vi.fn(
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
    const fetchMock = vi.fn(
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
    const fetchMock = vi.fn(async () => jsonResponse([{ tag: 'slow', count: 42 }]));
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await client.tags('sl');
    expect(fetchMock.mock.calls[0]![0] as string).toBe('/telescope/api/tags?prefix=sl');
  });

  it('omits the prefix param when listing all tags', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([]));
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await client.tags();
    expect(fetchMock.mock.calls[0]![0] as string).toBe('/telescope/api/tags');
  });

  it('throws on a non-ok response', async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response,
    );
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await expect(client.meta()).rejects.toThrow();
  });

  it('GETs live queues', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ queues: [], capabilities: {} }));
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await client.liveQueues();
    expect(fetchMock.mock.calls[0]![0] as string).toBe('/telescope/api/queues/live');
    expect(fetchMock.mock.calls[0]![1]).toBeUndefined();
  });

  it('GETs queue counts with encoded path segments', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await client.queueCounts('bullmq', 'a/b');
    expect(fetchMock.mock.calls[0]![0] as string).toBe(
      '/telescope/api/queues/live/bullmq/a%2Fb/counts',
    );
  });

  it('GETs queue jobs with state + cursor + limit', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ jobs: [], nextCursor: null, total: null }));
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await client.queueJobs('bullmq', 'q1', 'failed', { cursor: 'c1', limit: 25 });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/telescope/api/queues/live/bullmq/q1/jobs?');
    expect(url).toContain('state=failed');
    expect(url).toContain('cursor=c1');
    expect(url).toContain('limit=25');
  });

  it('GETs a single live job', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(null));
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await client.queueJob('bullmq', 'q1', '99');
    expect(fetchMock.mock.calls[0]![0] as string).toBe(
      '/telescope/api/queues/live/bullmq/q1/jobs/99',
    );
  });

  it('POSTs a job action', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await client.queueJobAction('bullmq', 'q1', '99', 'retry');
    expect(fetchMock.mock.calls[0]![0] as string).toBe(
      '/telescope/api/queues/live/bullmq/q1/jobs/99/retry',
    );
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
  });

  it('POSTs a bulk queue action with a state query param', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, count: 4 }));
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await client.queueAction('bullmq', 'q1', 'retry-all', { state: 'failed' });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/telescope/api/queues/live/bullmq/q1/actions/retry-all?');
    expect(url).toContain('state=failed');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
  });
});
