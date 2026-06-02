import { describe, expect, it, vi } from 'vitest';
import { createTelescopeClient } from './telescope-client.js';

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

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

  it('throws on a non-ok response', async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response,
    );
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await expect(client.meta()).rejects.toThrow();
  });
});
