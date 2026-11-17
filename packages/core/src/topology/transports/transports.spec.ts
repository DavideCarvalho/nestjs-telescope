import { describe, expect, it, vi } from 'vitest';
import { fakeBullmq, fakeRedis } from '../../../test/topology/transport-fakes.js';
import type { Entry } from '../../entry/entry.js';
import { resolveTopology } from '../config.js';
import { createIngestHandler } from '../ingest.js';
import { hmacTenantVerifier, signTenantToken } from '../tenant-auth.js';
import type { TenantTransport, TransportListener } from '../transport.js';
import { ingestBatch } from '../wire.js';
import { bullmqTransport } from './bullmq.js';
import { transports } from './index.js';
import { redisTransport, streamEntries } from './redis.js';

const SECRET = 's';

function entry(id: string, tags: string[] = []): Entry {
  return {
    id,
    batchId: 'b',
    type: 'request',
    familyHash: null,
    content: { uri: `/${id}` },
    tags,
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'pod',
    traceId: null,
    spanId: null,
    createdAt: new Date(),
  };
}

function controlPlane(failStore: () => boolean = () => false) {
  const stored: Entry[] = [];
  const handler = createIngestHandler({
    verifyTenant: hmacTenantVerifier(SECRET),
    store: async (entries) => {
      if (failStore()) throw new Error('db down');
      stored.push(...entries);
    },
  });
  const logger = { warn: vi.fn() };
  return { stored, handler, logger };
}

const send = (transport: TenantTransport, partition: string, ids: string[], token?: string) =>
  transport.send(ingestBatch(ids.map((id) => entry(id, ['app:forged']))), {
    token: token ?? signTenantToken(partition, SECRET),
    partition,
  });

describe('transports.bullmq', () => {
  it('delivers a batch with the app from the token; a resend is one job', async () => {
    const bull = fakeBullmq();
    const transport = bullmqTransport({ connection: {}, bullmq: bull.module });
    const cp = controlPlane();
    await transport.listen?.(cp.handler, cp.logger);
    const batch = ingestBatch([entry('a', ['app:billing'])]);
    const creds = { token: signTenantToken('shop', SECRET), partition: 'billing' };
    expect(await transport.send(batch, creds)).toEqual({ status: 'sent' });
    expect(await transport.send(batch, creds)).toEqual({ status: 'sent' });
    await bull.drain();
    expect(cp.stored.map((e) => [e.id, e.tags])).toEqual([['a', ['app:shop']]]);
  });

  it('buffers while the broker is down (the tenant retries)', async () => {
    const bull = fakeBullmq();
    bull.setDown(true);
    const transport = bullmqTransport({ connection: {}, bullmq: bull.module });
    expect((await send(transport, 'shop', ['a'])).status).toBe('retry');
  });

  it('dead-letters a bad token at once and retries a store failure up to attempts', async () => {
    const bull = fakeBullmq();
    let fail = true;
    const transport = bullmqTransport({ connection: {}, bullmq: bull.module, attempts: 2 });
    const cp = controlPlane(() => fail);
    await transport.listen?.(cp.handler, cp.logger);
    await send(transport, 'shop', ['bad'], signTenantToken('shop', 'wrong'));
    await send(transport, 'shop', ['retry']);
    await bull.drain();
    const q = bull.queues.get('telescope-ingest');
    expect(q?.failed.map((j) => j.reason)).toEqual(['unauthenticated']);
    expect(q?.waiting).toHaveLength(1); // the store failure, retried
    fail = false;
    await bull.drain();
    expect(cp.stored.map((e) => e.id)).toEqual(['retry']);
  });

  it('dead-letters an oversized message unread', async () => {
    const bull = fakeBullmq();
    const transport = bullmqTransport({
      connection: {},
      bullmq: bull.module,
      maxMessageBytes: 100,
    });
    const cp = controlPlane();
    await transport.listen?.(cp.handler, cp.logger);
    await send(transport, 'shop', ['a']);
    await bull.drain();
    expect(bull.queues.get('telescope-ingest')?.failed[0]?.reason).toBe('message too large');
    expect(cp.stored).toHaveLength(0);
  });
});

describe('transports.redis', () => {
  async function setup(options: Parameters<typeof redisTransport>[0] = {}, fail = () => false) {
    const redis = fakeRedis();
    const transport = redisTransport({
      client: redis.client,
      pollMs: 5,
      minIdleMs: 1_000,
      reclaimIntervalMs: 0,
      ...options,
    });
    const cp = controlPlane(fail);
    const listeners: TransportListener[] = [];
    const listen = async () => {
      const listener = await transport.listen?.(cp.handler, cp.logger);
      if (listener) listeners.push(listener);
    };
    const settle = async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    };
    const stop = async () => {
      for (const l of listeners) await l.stop();
    };
    return { redis, transport, cp, listen, settle, stop };
  }

  it('delivers through a consumer group and acknowledges', async () => {
    const t = await setup();
    await t.listen();
    expect(await send(t.transport, 'shop', ['a', 'b'])).toEqual({ status: 'sent' });
    await t.settle();
    await t.stop();
    expect(t.cp.stored.map((e) => e.tags)).toEqual([['app:shop'], ['app:shop']]);
    expect(t.redis.pending('telescope:ingest')).toBe(0);
  });

  it('a second consumer group start is fine (BUSYGROUP)', async () => {
    const t = await setup();
    await t.listen();
    await t.listen();
    await t.stop();
  });

  it('buffers while redis is down', async () => {
    const t = await setup();
    t.redis.setDown(true);
    expect((await send(t.transport, 'shop', ['a'])).status).toBe('retry');
  });

  it('dead-letters a bad token and poison messages', async () => {
    const t = await setup();
    await t.listen();
    await send(t.transport, 'shop', ['a'], 'forged');
    await t.redis.client.xadd('telescope:ingest', 'MAXLEN', '~', 10, '*', 'data', '{not json');
    await t.redis.client.xadd('telescope:ingest', 'MAXLEN', '~', 10, '*', 'data', '{"v":9}');
    await t.settle();
    await t.stop();
    const dead = t.redis.streams.get('telescope:ingest:dead')?.entries ?? [];
    expect(dead.map(([, fields]) => fields[3])).toEqual([
      'unauthenticated',
      'not JSON',
      'unauthenticated',
    ]);
    expect(t.redis.pending('telescope:ingest')).toBe(0);
    expect(t.cp.stored).toHaveLength(0);
  });

  it('takes over a message left pending and dead-letters it after maxAttempts', async () => {
    let fail = true;
    const t = await setup({ maxAttempts: 3 }, () => fail);
    await t.listen();
    await send(t.transport, 'shop', ['a']);
    await t.settle();
    expect(t.redis.pending('telescope:ingest')).toBe(1);
    // The store is back: the idle message is taken over and stored.
    fail = false;
    t.redis.advance(1_000);
    await t.settle();
    expect(t.cp.stored.map((e) => e.id)).toEqual(['a']);
    expect(t.redis.pending('telescope:ingest')).toBe(0);

    fail = true;
    await send(t.transport, 'shop', ['b']);
    await t.settle();
    for (let i = 0; i < 3; i++) {
      t.redis.advance(1_000);
      await t.settle();
    }
    await t.stop();
    const dead = t.redis.streams.get('telescope:ingest:dead')?.entries ?? [];
    expect(dead).toHaveLength(1);
    expect(t.redis.pending('telescope:ingest')).toBe(0);
  });

  it('blocks on a duplicated connection: idle costs one read per blockMs, stop() does not wait', async () => {
    const redis = fakeRedis({ duplicate: true });
    const transport = redisTransport({ client: redis.client, blockMs: 60, pollMs: 5 });
    const cp = controlPlane();
    const listener = await transport.listen?.(cp.handler, cp.logger);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // ~200 ms idle: a polling consumer at 5 ms would have sent dozens of reads and take-overs.
    expect(redis.count('xreadgroup')).toBeLessThanOrEqual(5);
    expect(redis.count('xpending')).toBe(1); // on start only
    // A message is read as soon as it lands, not at the end of the block.
    const sentAt = Date.now();
    await send(transport, 'shop', ['a']);
    for (let i = 0; i < 40 && cp.stored.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(cp.stored.map((e) => e.id)).toEqual(['a']);
    expect(Date.now() - sentAt).toBeLessThan(50);
    const stopAt = Date.now();
    await listener?.stop();
    expect(Date.now() - stopAt).toBeLessThan(50);
    expect(redis.pending('telescope:ingest')).toBe(0);
  });

  it('stop() cuts a long block short', async () => {
    const redis = fakeRedis({ duplicate: true });
    const transport = redisTransport({ client: redis.client, blockMs: 30_000 });
    const cp = controlPlane();
    const listener = await transport.listen?.(cp.handler, cp.logger);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stopAt = Date.now();
    await listener?.stop();
    expect(Date.now() - stopAt).toBeLessThan(100);
    expect(cp.logger.warn).not.toHaveBeenCalled();
  });

  it('acknowledges one read with one XACK', async () => {
    const t = await setup();
    await send(t.transport, 'shop', ['a']);
    await send(t.transport, 'shop', ['b']);
    await send(t.transport, 'shop', ['c'], 'forged');
    await t.listen();
    await t.settle();
    await t.stop();
    expect(t.cp.stored.map((e) => e.id)).toEqual(['a', 'b']);
    expect(t.redis.count('xack')).toBe(1);
    expect(t.redis.pending('telescope:ingest')).toBe(0);
  });

  it('takes over pending messages every reclaimIntervalMs, not on every read', async () => {
    const t = await setup({ reclaimIntervalMs: 60_000 });
    await t.listen();
    await t.settle();
    await t.stop();
    expect(t.redis.count('xreadgroup')).toBeGreaterThan(2);
    expect(t.redis.count('xpending')).toBe(1);
  });

  it('trims what every group acknowledged, never a pending message', async () => {
    let fail = false;
    const t = await setup({ trimIntervalMs: 1, reclaimIntervalMs: 60_000 }, () => fail);
    await t.listen();
    await send(t.transport, 'shop', ['a']);
    await t.settle();
    fail = true;
    await send(t.transport, 'shop', ['b']); // left pending
    await t.settle();
    fail = false;
    await send(t.transport, 'shop', ['c']);
    await t.settle();
    await t.stop();
    const entries = t.redis.streams.get('telescope:ingest')?.entries ?? [];
    // `a` is gone; `b` (pending) and everything after it stay.
    expect(entries.map(([id]) => id)).toEqual(['2-0', '3-0']);
    expect(t.redis.count('xtrim')).toBeGreaterThan(0);
  });

  it('idles without trimming when nothing was acknowledged', async () => {
    const t = await setup({ trimIntervalMs: 1 });
    await t.listen();
    await t.settle();
    await t.stop();
    expect(t.redis.count('xinfo')).toBe(0);
    expect(t.redis.count('xtrim')).toBe(0);
  });

  it('a tenant sends every 5 s by default over redis (configurable)', () => {
    const client = fakeRedis().client;
    expect(redisTransport({ client }).sendIntervalMs).toBe(5_000);
    expect(redisTransport({ client, sendIntervalMs: 1_000 }).sendIntervalMs).toBe(1_000);
    expect(transports.http({ url: 'http://x' }).sendIntervalMs).toBeUndefined();
  });

  it('reads RESP2 and RESP3 reply shapes', () => {
    const fields = ['data', '{}'];
    expect(streamEntries([['s', [['1-0', fields]]]])).toEqual([['1-0', fields]]);
    expect(streamEntries([['1-0', fields]])).toEqual([['1-0', fields]]);
    expect(streamEntries({ s: [['1-0', fields]] })).toEqual([['1-0', fields]]);
    expect(streamEntries([['1-0', null]])).toEqual([]);
    expect(streamEntries(null)).toEqual([]);
  });
});

describe('mixed fleet: HTTP and broker tenants into one control plane', () => {
  it('stores both, each with its own app, deduping across transports', async () => {
    const redis = fakeRedis();
    const broker = redisTransport({ client: redis.client, pollMs: 5 });
    const cp = controlPlane();
    const listener = await broker.listen?.(cp.handler, cp.logger);
    // The HTTP tenant posts to the same handler the ingest route uses.
    const httpTenant = transports.http({
      url: 'http://cp/telescope',
      fetch: async (_url, init) => {
        const token = String((init?.headers as Record<string, string>).authorization).slice(7);
        const outcome = await cp.handler({ token, body: JSON.parse(String(init?.body)) });
        return new Response(null, { status: outcome.status === 'stored' ? 202 : 400 });
      },
    });
    expect((await send(httpTenant, 'shop', ['s1'])).status).toBe('sent');
    expect((await send(broker, 'billing', ['b1'])).status).toBe('sent');
    // The same billing batch through HTTP too: stored once.
    await send(httpTenant, 'billing', ['b1']);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await listener?.stop();
    expect(cp.stored.map((e) => `${e.id}:${e.tags.join()}`).sort()).toEqual([
      'b1:app:billing',
      's1:app:shop',
    ]);
  });
});

describe('config', () => {
  it('a control plane takes a broker transport; HTTP has no consumer', () => {
    const verifyTenant = hmacTenantVerifier('s');
    const broker = redisTransport({ client: fakeRedis().client });
    const resolved = resolveTopology({
      topology: 'control-plane',
      verifyTenant,
      transport: broker,
    });
    expect(resolved.kind === 'control-plane' && resolved.transport?.kind).toBe('redis');
    expect(() =>
      resolveTopology({
        topology: 'control-plane',
        verifyTenant,
        transport: transports.http({ url: 'http://x' }),
      }),
    ).toThrow(/no consumer/);
    expect(() => resolveTopology({ transport: broker })).toThrow(/control-plane/);
    expect(() =>
      resolveTopology({
        topology: 'tenant',
        tenant: { url: 'http://x', partition: 'p', token: 't' },
        transport: broker,
      }),
    ).toThrow(/tenant.transport/);
  });

  it('needs a connection, and loads the peer only when used', async () => {
    expect(() => bullmqTransport({} as never)).toThrow(/connection/);
    expect(() => redisTransport({})).toThrow(/connection/);
    // Building a driver imports nothing; a send imports the peer (installed here as a devDependency).
    const transport = bullmqTransport({
      connection: {
        host: '127.0.0.1',
        port: 1,
        maxRetriesPerRequest: 0,
        lazyConnect: true,
        enableOfflineQueue: false,
      },
    });
    expect(transport.kind).toBe('bullmq');
  });
});
