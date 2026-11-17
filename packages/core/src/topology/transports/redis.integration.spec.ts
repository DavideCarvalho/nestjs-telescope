// Real Redis: runs only with TELESCOPE_TEST_REDIS_URL (e.g. redis://127.0.0.1:6379/15). The fakes
// cover the logic; this checks the reply shapes of a real server and BullMQ end to end.
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Entry } from '../../entry/entry.js';
import { createIngestHandler } from '../ingest.js';
import { hmacTenantVerifier, signTenantToken } from '../tenant-auth.js';
import { ingestBatch } from '../wire.js';
import { bullmqTransport } from './bullmq.js';
import { redisTransport } from './redis.js';

const url = process.env.TELESCOPE_TEST_REDIS_URL;
const SECRET = 's';
const clients: Redis[] = [];
afterAll(async () => {
  for (const c of clients) await c.quit();
});

function entry(id: string): Entry {
  return {
    id,
    batchId: 'b',
    type: 'log',
    familyHash: null,
    content: { message: id },
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'manual',
    instanceId: 'x',
    traceId: null,
    spanId: null,
    createdAt: new Date(),
  };
}

function controlPlane() {
  const stored: Entry[] = [];
  const handler = createIngestHandler({
    verifyTenant: hmacTenantVerifier(SECRET),
    store: async (entries) => {
      stored.push(...entries);
    },
  });
  return { stored, handler, logger: { warn: vi.fn() } };
}

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out');
};

describe.skipIf(!url)('real Redis', () => {
  it('redis streams: round trip and dead stream', async () => {
    const client = new Redis(url as string);
    clients.push(client);
    const prefix = `telescope-test-${randomUUID()}`;
    const transport = redisTransport({ client, prefix, pollMs: 10 });
    const cp = controlPlane();
    const listener = await transport.listen?.(cp.handler, cp.logger);
    const creds = { token: signTenantToken('shop', SECRET), partition: 'shop' };
    expect(await transport.send(ingestBatch([entry('a')]), creds)).toEqual({ status: 'sent' });
    await transport.send(ingestBatch([entry('b')]), { token: 'forged', partition: 'shop' });
    await until(
      async () => cp.stored.length === 1 && (await client.xlen(`${prefix}:ingest:dead`)) === 1,
    );
    await listener?.stop();
    expect(cp.stored[0]?.tags).toEqual(['app:shop']);
    const pending = (await client.xpending(`${prefix}:ingest`, 'telescope')) as unknown[];
    expect(pending[0]).toBe(0);
    await client.del(`${prefix}:ingest`, `${prefix}:ingest:dead`);
  });

  it('redis streams: blocks on its own connection, one XACK per read, trims, stops at once', async () => {
    const client = new Redis(url as string);
    clients.push(client);
    const prefix = `telescope-test-${randomUUID()}`;
    const stream = `${prefix}:ingest`;
    const transport = redisTransport({ client, prefix, blockMs: 30_000, trimIntervalMs: 1 });
    const creds = { token: signTenantToken('shop', SECRET), partition: 'shop' };
    // Three messages before the consumer starts: one read, one XACK.
    for (const id of ['a', 'b', 'c']) await transport.send(ingestBatch([entry(id)]), creds);
    const cp = controlPlane();
    const listener = await transport.listen?.(cp.handler, cp.logger);
    await until(() => cp.stored.length === 3);
    // While it waits on a 30 s BLOCK, a new message is read at once.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await transport.send(ingestBatch([entry('d')]), creds);
    await until(() => cp.stored.length === 4);
    // Every message was acknowledged and trimmed away (the trim runs after a read).
    await until(async () => (await client.xlen(stream)) <= 1);
    const stopAt = Date.now();
    await listener?.stop();
    expect(Date.now() - stopAt).toBeLessThan(1_000);
    expect(cp.logger.warn).not.toHaveBeenCalled();
    const pending = (await client.xpending(stream, 'telescope')) as unknown[];
    expect(pending[0]).toBe(0);
    // The shared client is still usable: only the duplicated reader was closed.
    expect(await client.ping()).toBe('PONG');
    await client.del(stream, `${prefix}:ingest:dead`);
  });

  it('bullmq: round trip and failed set', async () => {
    const connection = { url: url as string, maxRetriesPerRequest: null };
    const queue = `telescope-test-${randomUUID()}`;
    const transport = bullmqTransport({ connection, queue });
    const cp = controlPlane();
    const listener = await transport.listen?.(cp.handler, cp.logger);
    const creds = { token: signTenantToken('billing', SECRET), partition: 'billing' };
    expect(await transport.send(ingestBatch([entry('c')]), creds)).toEqual({ status: 'sent' });
    await transport.send(ingestBatch([entry('d')]), { token: 'forged', partition: 'billing' });
    await until(() => cp.stored.length === 1 && cp.logger.warn.mock.calls.length > 0);
    await listener?.stop();
    await transport.close?.();
    expect(cp.stored[0]?.tags).toEqual(['app:billing']);
    const { Queue } = await import('bullmq');
    const q = new Queue(queue, { connection });
    await until(async () => (await q.getFailedCount()) === 1);
    await q.obliterate({ force: true });
    await q.close();
  });
});
