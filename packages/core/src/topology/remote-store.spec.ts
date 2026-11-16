import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { resolveTopology } from './config.js';
import { RemoteTelescopeStore } from './remote-store.js';
import { hmacTenantVerifier } from './tenant-auth.js';
import { type SendResult, type TenantTransport, httpTransport, ingestUrl } from './transport.js';
import type { IngestBatch } from './wire.js';

function entry(id: string, content: unknown = { uri: `/${id}` }): Entry {
  return {
    id,
    batchId: 'b',
    type: 'request',
    familyHash: null,
    content,
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'pod',
    traceId: null,
    spanId: null,
    createdAt: new Date('2026-11-16T12:00:00.000Z'),
  };
}

/** A transport that answers from a script and remembers what it got. */
function fakeTransport(answers: SendResult[] = []) {
  const sent: { batch: IngestBatch; token: string; partition: string }[] = [];
  const transport: TenantTransport & { sent: typeof sent; closed: boolean } = {
    kind: 'fake',
    sent,
    closed: false,
    async send(batch, credentials) {
      sent.push({ batch, ...credentials });
      return answers.shift() ?? { status: 'sent' };
    },
    async close() {
      transport.closed = true;
    },
  };
  return transport;
}

const stores: RemoteTelescopeStore[] = [];
function remote(options: Partial<ConstructorParameters<typeof RemoteTelescopeStore>[0]> = {}) {
  let now = 0;
  const transport = (options.transport as ReturnType<typeof fakeTransport>) ?? fakeTransport();
  const store = new RemoteTelescopeStore({
    transport,
    partition: 'shop',
    token: 'tok',
    intervalMs: 60_000,
    now: () => now,
    ...options,
  });
  stores.push(store);
  const advance = (ms: number): void => {
    now += ms;
  };
  return { store, transport, advance };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

describe('RemoteTelescopeStore', () => {
  it('ships stored entries with the token and partition, in batches', async () => {
    const { store, transport } = remote({ batchSize: 2 });
    await store.store([entry('a'), entry('b'), entry('c')]);
    await store.ship();
    expect(transport.sent.map((s) => s.batch.entries.map((e) => e.id))).toEqual([
      ['a', 'b'],
      ['c'],
    ]);
    expect(transport.sent[0]).toMatchObject({ token: 'tok', partition: 'shop' });
    expect(transport.sent[0]?.batch.entries[0]?.createdAt).toBe('2026-11-16T12:00:00.000Z');
    expect(store.stats()).toMatchObject({ sent: 3, buffered: 0, dropped: 0, failures: 0 });
  });

  it('resends the same batch (same id) after a failure, with backoff', async () => {
    const transport = fakeTransport([{ status: 'retry', reason: 'down' }]);
    const { store, advance } = remote({ transport, retryDelayMs: 1_000 });
    await store.store([entry('a')]);
    await store.ship();
    expect(store.stats()).toMatchObject({ failures: 1, buffered: 1, lastError: 'down' });
    await store.ship(); // still backing off
    expect(transport.sent).toHaveLength(1);
    advance(1_000);
    await store.ship();
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1]?.batch.id).toBe(transport.sent[0]?.batch.id);
    expect(store.stats()).toMatchObject({ sent: 1, buffered: 0, lastError: null });
  });

  it('drops a batch the control plane can never take', async () => {
    const transport = fakeTransport([{ status: 'drop', reason: '400' }]);
    const { store } = remote({ transport });
    await store.store([entry('a'), entry('b')]);
    await store.ship();
    expect(store.stats()).toMatchObject({ dropped: 2, buffered: 0, sent: 0 });
  });

  it('bounds the buffer, dropping the oldest', async () => {
    const { store, transport } = remote({ bufferSize: 2 });
    await store.store([entry('a'), entry('b'), entry('c')]);
    await store.ship();
    expect(transport.sent[0]?.batch.entries.map((e) => e.id)).toEqual(['b', 'c']);
    expect(store.stats().dropped).toBe(1);
  });

  it('splits batches above maxBatchBytes and drops a single entry that cannot fit', async () => {
    const { store, transport } = remote({ maxBatchBytes: 1_500 });
    await store.store([
      entry('a', { body: 'x'.repeat(700) }),
      entry('b', { body: 'x'.repeat(700) }),
      entry('huge', { body: 'x'.repeat(5_000) }),
    ]);
    await store.ship();
    expect(transport.sent.map((s) => s.batch.entries.map((e) => e.id))).toEqual([['a'], ['b']]);
    expect(store.stats().dropped).toBe(1);
  });

  it('queues an array once when the recorder retries a failed local store', async () => {
    const local = new InMemoryStorageProvider();
    const fail = vi.spyOn(local, 'store').mockRejectedValueOnce(new Error('disk full'));
    const { store, transport } = remote({ local });
    const batch = [entry('a')];
    await expect(store.store(batch)).rejects.toThrow('disk full');
    await store.store(batch);
    await store.ship();
    expect(fail).toHaveBeenCalledTimes(2);
    expect(transport.sent.flatMap((s) => s.batch.entries)).toHaveLength(1);
    expect((await store.get({})).data.map((e) => e.id)).toEqual(['a']);
  });

  it('reads nothing without a local copy', async () => {
    const { store } = remote();
    await store.store([entry('a')]);
    expect(await store.get({})).toEqual({ data: [], nextCursor: null });
    expect(await store.find('a')).toBeNull();
    expect(await store.prune(new Date())).toBe(0);
  });

  it('sends what is left on close, then closes the transport', async () => {
    const { store, transport } = remote();
    await store.store([entry('a')]);
    await store.close();
    expect(transport.sent).toHaveLength(1);
    expect(transport.closed).toBe(true);
  });

  it('calls a token function before each send', async () => {
    let n = 0;
    const { store, transport } = remote({ token: async () => `tok-${++n}`, batchSize: 1 });
    await store.store([entry('a'), entry('b')]);
    await store.ship();
    expect(transport.sent.map((s) => s.token)).toEqual(['tok-1', 'tok-2']);
  });
});

describe('RemoteTelescopeStore heartbeats', () => {
  it('a heartbeat rides the next batch, or goes alone; only the newest is kept', async () => {
    const { store, transport } = remote();
    store.setHeartbeat({ n: 1 });
    store.setHeartbeat({ n: 2 });
    await store.ship();
    expect(transport.sent.map((s) => [s.batch.entries.length, s.batch.heartbeat])).toEqual([
      [0, { n: 2 }],
    ]);
    await store.store([entry('a')]);
    store.setHeartbeat({ n: 3 });
    await store.ship();
    expect(transport.sent[1]?.batch.entries.map((e) => e.id)).toEqual(['a']);
    expect(transport.sent[1]?.batch.heartbeat).toEqual({ n: 3 });
    await store.ship();
    expect(transport.sent).toHaveLength(2);
    expect(store.stats()).toMatchObject({ sent: 1, dropped: 0, lagMs: 0 });
  });

  it('reports how long the oldest waiting entry has waited', async () => {
    const transport = fakeTransport([{ status: 'retry', reason: 'down' }]);
    const { store, advance } = remote({
      transport,
      now: () => Date.parse('2026-11-16T12:00:05.000Z'),
    });
    await store.store([entry('a')]);
    await store.ship();
    advance(0);
    expect(store.stats()).toMatchObject({ buffered: 1, consecutiveFailures: 1, lagMs: 5_000 });
  });
});

describe('transports.http', () => {
  it('posts to <url>/api/ingest with the bearer token', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 202 }));
    const transport = httpTransport({ url: 'https://cp.test/telescope/', fetch });
    const batch = { v: 1, id: 'b1', sentAt: 'now', entries: [] } as IngestBatch;
    expect(await transport.send(batch, { token: 't', partition: 'shop' })).toEqual({
      status: 'sent',
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://cp.test/telescope/api/ingest');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer t');
    expect(ingestUrl('http://x/t')).toBe('http://x/t/api/ingest');
  });

  it('retries on 5xx, 401 and network errors; drops on 400 and 413', async () => {
    const batch = { v: 1, id: 'b1', sentAt: 'now', entries: [] } as IngestBatch;
    const status = async (code: number) =>
      (
        await httpTransport({
          url: 'http://cp',
          fetch: async () => new Response(null, { status: code }),
        }).send(batch, { token: 't', partition: 'p' })
      ).status;
    expect(await status(503)).toBe('retry');
    expect(await status(401)).toBe('retry');
    expect(await status(400)).toBe('drop');
    expect(await status(413)).toBe('drop');
    const down = httpTransport({
      url: 'http://cp',
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect((await down.send(batch, { token: 't', partition: 'p' })).status).toBe('retry');
  });
});

describe('resolveTopology', () => {
  const verifyTenant = hmacTenantVerifier('s');
  it('defaults to standalone', () => {
    expect(resolveTopology({})).toEqual({ kind: 'standalone' });
  });

  it('needs verifyTenant on a control plane', () => {
    expect(() => resolveTopology({ topology: 'control-plane' })).toThrow(/verifyTenant/);
    expect(resolveTopology({ topology: 'control-plane', verifyTenant }).kind).toBe('control-plane');
  });

  it('validates a tenant', () => {
    const tenant = { url: 'http://cp/telescope', partition: 'shop', token: 't' };
    expect(() => resolveTopology({ topology: 'tenant' })).toThrow(/tenant/);
    expect(() =>
      resolveTopology({ topology: 'tenant', tenant: { ...tenant, partition: 'a b' } }),
    ).toThrow(/partition/);
    expect(() => resolveTopology({ topology: 'tenant', tenant: { ...tenant, token: '' } })).toThrow(
      /token/,
    );
    expect(() =>
      resolveTopology({ topology: 'tenant', tenant: { partition: 'shop', token: 't' } }),
    ).toThrow(/url/);
    expect(() =>
      resolveTopology({ topology: 'tenant', tenant, storage: new InMemoryStorageProvider() }),
    ).toThrow(/tenant.local/);
    expect(() => resolveTopology({ tenant })).toThrow(/topology/);
    const resolved = resolveTopology({ topology: 'tenant', tenant });
    expect(resolved.kind === 'tenant' && resolved.transport.kind).toBe('http');
  });
});
