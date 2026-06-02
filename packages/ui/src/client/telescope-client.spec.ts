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

  it('throws on a non-ok response', async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response,
    );
    const client = createTelescopeClient({ baseUrl: '/telescope/api', fetch: fetchMock });
    await expect(client.meta()).rejects.toThrow();
  });
});
