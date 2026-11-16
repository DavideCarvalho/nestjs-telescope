// packages/core/src/topology/lazy-url.spec.ts
import { describe, expect, it, vi } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { resolveTopology } from './config.js';
import { RemoteTelescopeStore } from './remote-store.js';
import { ServerUrl } from './server-url.js';
import { SERVER_URL, httpTransport } from './transport.js';
import type { IngestBatch } from './wire.js';

const batch = { v: 1, id: 'b1', sentAt: 'now', entries: [] } as IngestBatch;
const credentials = { token: 't', partition: 'shop' };

function entry(id: string, tags: string[] = []): Entry {
  return {
    id,
    batchId: 'b',
    type: 'request',
    familyHash: null,
    content: {},
    tags,
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'pod',
    traceId: null,
    spanId: null,
    createdAt: new Date('2026-11-16T12:00:00.000Z'),
  };
}

describe('lazy control plane URL', () => {
  it('accepts a function for tenant.url, and calls it on the first send, not at boot', async () => {
    const lookup = vi.fn(async () => 'https://cp.test/telescope/');
    const topology = resolveTopology({
      topology: 'tenant',
      tenant: { url: lookup, partition: 'shop', token: 't' },
    });
    expect(lookup).not.toHaveBeenCalled();
    if (topology.kind !== 'tenant') throw new Error('tenant expected');
    const server = (topology.transport as unknown as Record<typeof SERVER_URL, ServerUrl>)[
      SERVER_URL
    ];
    expect(server.lazy).toBe(true);
    expect(await server.get()).toBe('https://cp.test/telescope');
    expect(await server.get()).toBe('https://cp.test/telescope');
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('refuses a tenant.url that is neither a string nor a function at boot', () => {
    expect(() =>
      resolveTopology({
        topology: 'tenant',
        tenant: { url: 42 as never, partition: 'shop', token: 't' },
      }),
    ).toThrow(/needs `url`/);
  });

  it('keeps entries buffered while the lookup fails, and sends once it succeeds', async () => {
    let up = false;
    const fetch = vi.fn(async () => new Response(null, { status: 202 }));
    const transport = httpTransport({
      url: async () => {
        if (!up) throw new Error('discovery down');
        return 'http://cp/telescope';
      },
      fetch,
    });
    const store = new RemoteTelescopeStore({
      transport,
      partition: 'shop',
      token: 't',
      intervalMs: 60_000,
      retryDelayMs: 0,
    });
    await store.store([entry('a')]);
    await store.ship({ ignoreBackoff: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(store.stats()).toMatchObject({ buffered: 1, sent: 0 });
    expect(store.stats().lastError).toMatch(/discovery down/);
    up = true;
    await store.ship({ ignoreBackoff: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(store.stats()).toMatchObject({ buffered: 0, sent: 1 });
    await store.close();
  });

  it('looks the URL up again after a connection error, and resends to the new one', async () => {
    const urls = ['http://old/telescope', 'http://new/telescope'];
    const lookup = Object.assign(
      vi.fn(async () => urls[0] as string),
      {
        refresh: vi.fn(async () => urls[1] as string),
      },
    );
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith('http://old')) throw new Error('ECONNREFUSED');
      return new Response(null, { status: 202 });
    });
    const transport = httpTransport({
      url: lookup,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(await transport.send(batch, credentials)).toEqual({ status: 'sent' });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'http://old/telescope/api/ingest',
      'http://new/telescope/api/ingest',
    ]);
    expect(lookup.refresh).toHaveBeenCalledTimes(1);
    // The new URL is kept.
    await transport.send(batch, credentials);
    expect(fetch.mock.calls.at(-1)?.[0]).toBe('http://new/telescope/api/ingest');
  });

  it('looks it up again on a 404 (calling the function without refresh), not on a 503', async () => {
    let calls = 0;
    const lookup = vi.fn(async () => (calls++ === 0 ? 'http://a' : 'http://b'));
    const fetch = vi.fn(
      async (url: string) => new Response(null, { status: url.startsWith('http://a') ? 404 : 202 }),
    );
    const transport = httpTransport({
      url: lookup,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(await transport.send(batch, credentials)).toEqual({ status: 'sent' });
    expect(lookup).toHaveBeenCalledTimes(2);

    const busy = vi.fn(async () => new Response(null, { status: 503 }));
    const steady = vi.fn(async () => 'http://c');
    const other = httpTransport({ url: steady, fetch: busy as unknown as typeof globalThis.fetch });
    expect((await other.send(batch, credentials)).status).toBe('retry');
    expect(steady).toHaveBeenCalledTimes(1);
  });

  it('does not resend when the URL did not change', async () => {
    const lookup = vi.fn(async () => 'http://same');
    const fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const transport = httpTransport({
      url: lookup,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect((await transport.send(batch, credentials)).status).toBe('retry');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fails a send with a clear error when the lookup returns a bad URL', async () => {
    const transport = httpTransport({ url: async () => 'not a url' });
    const result = await transport.send(batch, credentials);
    expect(result.status).toBe('retry');
    expect(result.status !== 'sent' && result.reason).toMatch(/absolute http\(s\) URL/);
  });
});

describe('tenant.relay', () => {
  it('tags the relayer’s own entries app:<partition> and leaves relayed ones as they are', async () => {
    const local = new InMemoryStorageProvider();
    const sent: IngestBatch[] = [];
    const store = new RemoteTelescopeStore({
      transport: {
        kind: 'fake',
        async send(b) {
          sent.push(b);
          return { status: 'sent' };
        },
      },
      partition: 'durable',
      token: 't',
      relay: true,
      local,
      intervalMs: 60_000,
    });
    await store.store([entry('own', ['x']), entry('relayed', ['app:shop'])]);
    await store.ship();
    expect(sent[0]?.entries.map((e) => e.tags)).toEqual([['x', 'app:durable'], ['app:shop']]);
    expect((await local.get({ limit: 10 })).data.map((e) => e.tags).sort()).toEqual([
      ['app:shop'],
      ['x', 'app:durable'],
    ]);
    await store.close();
  });

  it('never touches tags without relay', async () => {
    const sent: IngestBatch[] = [];
    const store = new RemoteTelescopeStore({
      transport: {
        kind: 'fake',
        async send(b) {
          sent.push(b);
          return { status: 'sent' };
        },
      },
      partition: 'durable',
      token: 't',
      intervalMs: 60_000,
    });
    await store.store([entry('own', ['x'])]);
    await store.ship();
    expect(sent[0]?.entries[0]?.tags).toEqual(['x']);
    await store.close();
  });

  it('must be a boolean', () => {
    expect(() =>
      resolveTopology({
        topology: 'tenant',
        tenant: { url: 'http://cp', partition: 'a', token: 't', relay: 'yes' as never },
      }),
    ).toThrow(/tenant.relay` must be a boolean/);
  });
});

describe('one lookup per tenant', () => {
  it('shares the derived transport (and its URL lookup) across resolutions', () => {
    const tenant = { url: async () => 'http://cp', partition: 'shop', token: 't' };
    const first = resolveTopology({ topology: 'tenant', tenant });
    const second = resolveTopology({ topology: 'tenant', tenant });
    if (first.kind !== 'tenant' || second.kind !== 'tenant') throw new Error('tenant expected');
    expect(second.transport).toBe(first.transport);
  });
});
