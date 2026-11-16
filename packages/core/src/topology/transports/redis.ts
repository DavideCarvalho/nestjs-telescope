// packages/core/src/topology/transports/redis.ts
//
// Redis streams: tenants `XADD` to `<prefix>:ingest`, the control plane reads it through a consumer
// group. `ioredis` is an optional peer, imported only when this driver builds its own client.
import { hostname } from 'node:os';
import type { IngestHandler } from '../ingest.js';
import {
  type TenantTransport,
  type TransportListener,
  type TransportLogger,
  importPeer,
  isDeadLetter,
} from '../transport.js';
import type { IngestEnvelope } from '../wire.js';

/** The commands this driver sends: an ioredis client satisfies it. */
export interface RedisStreamClient {
  xadd(...args: (string | number)[]): Promise<unknown>;
  xgroup(...args: (string | number)[]): Promise<unknown>;
  xreadgroup(...args: (string | number)[]): Promise<unknown>;
  xack(...args: (string | number)[]): Promise<unknown>;
  xpending(...args: (string | number)[]): Promise<unknown>;
  xclaim(...args: (string | number)[]): Promise<unknown>;
  quit?(): Promise<unknown>;
}

export interface RedisTransportOptions {
  /** ioredis options or a URL; the driver builds (and closes) its own client. */
  connection?: unknown;
  /**
   * An ioredis client to use instead (not closed by the driver). Typed loosely so any ioredis
   * version fits; it must answer the stream commands of {@link RedisStreamClient}.
   */
  client?: object;
  /** Key prefix: the stream is `<prefix>:ingest`, dead letters `<prefix>:ingest:dead`. Default `telescope`. */
  prefix?: string;
  /** The control plane's consumer group. Default `telescope`. */
  group?: string;
  /** This control plane instance's consumer name. Default `<hostname>-<pid>`. */
  consumer?: string;
  /** Approximate cap of the stream (`MAXLEN ~`). Default 100 000 messages. */
  maxLen?: number;
  /** Approximate cap of the dead-letter stream. Default 10 000. */
  maxDead?: number;
  /** Deliveries of a message before it is dead-lettered. Default 5. */
  maxAttempts?: number;
  /** How long a message stays unacknowledged before another read takes it over. Default 30 000 ms. */
  minIdleMs?: number;
  /** How often the control plane reads when the stream is idle. Default 500 ms. */
  pollMs?: number;
  /** Messages read per call. Default 20. */
  count?: number;
  /** A larger message is dead-lettered unread. Default 1 MiB. */
  maxMessageBytes?: number;
}

type StreamEntry = [id: string, fields: string[]];

/**
 * The entries of an `XREADGROUP` / `XCLAIM` reply. RESP2 gives `[[stream, [[id, fields]]]]` (or
 * `[[id, fields]]` for `XCLAIM`); a RESP3 client may give a map or flatten the fields. Every shape
 * is read here, and anything else is no entries.
 */
export function streamEntries(reply: unknown): StreamEntry[] {
  if (reply === null || reply === undefined) return [];
  if (!Array.isArray(reply)) {
    // RESP3 map: { stream: entries }
    if (typeof reply === 'object') {
      return Object.values(reply as Record<string, unknown>).flatMap((v) => streamEntries(v));
    }
    return [];
  }
  const out: StreamEntry[] = [];
  for (const item of reply) {
    if (!Array.isArray(item)) continue;
    const [first, second] = item;
    if (
      typeof first === 'string' &&
      Array.isArray(second) &&
      second.every((f) => !Array.isArray(f))
    ) {
      out.push([first, second.map(String)]);
    } else if (typeof first === 'string' && Array.isArray(second)) {
      // [stream, entries]
      out.push(...streamEntries(second));
    }
    // Anything else (a claimed entry deleted meanwhile: `[id, null]`) carries nothing to handle.
  }
  return out;
}

function field(fields: string[], name: string): string | undefined {
  for (let i = 0; i + 1 < fields.length; i += 2) if (fields[i] === name) return fields[i + 1];
  return undefined;
}

/**
 * Tenants `XADD` each batch to `<prefix>:ingest` (capped with `MAXLEN ~`). The control plane reads
 * it with a consumer group (non-blocking reads, so a shared client is fine), acknowledges what it
 * stored, moves refused or poison messages to `<prefix>:ingest:dead`, and takes over messages left
 * unacknowledged for `minIdleMs` (a control plane that died, or a store that was down), up to
 * `maxAttempts` deliveries.
 */
export function redisTransport(options: RedisTransportOptions = {}): TenantTransport {
  if (options.client === undefined && options.connection === undefined) {
    throw new Error('telescope transports.redis: pass `connection` (ioredis options) or `client`.');
  }
  const prefix = options.prefix ?? 'telescope';
  const stream = `${prefix}:ingest`;
  const dead = `${prefix}:ingest:dead`;
  const group = options.group ?? 'telescope';
  const consumer = options.consumer ?? `${hostname()}-${process.pid}`;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
  const minIdleMs = options.minIdleMs ?? 30_000;
  const pollMs = options.pollMs ?? 500;
  const count = options.count ?? 20;
  const maxBytes = options.maxMessageBytes ?? 1024 * 1024;
  let client: Promise<RedisStreamClient> | undefined;
  const owned = options.client === undefined;
  const clientOf = (): Promise<RedisStreamClient> => {
    client ??= options.client
      ? Promise.resolve(options.client as RedisStreamClient)
      : importPeer<{ default: new (connection: unknown) => RedisStreamClient }>(
          'ioredis',
          'redis',
        ).then((ioredis) => new ioredis.default(options.connection));
    return client;
  };

  async function deadLetter(redis: RedisStreamClient, id: string, raw: string, reason: string) {
    await redis.xadd(
      dead,
      'MAXLEN',
      '~',
      options.maxDead ?? 10_000,
      '*',
      'data',
      raw,
      'reason',
      reason,
      'id',
      id,
    );
    await redis.xack(stream, group, id);
  }

  /** Handles one message. `true` when it is settled (acknowledged or dead-lettered). */
  async function handle(
    redis: RedisStreamClient,
    handler: IngestHandler,
    logger: TransportLogger,
    [id, fields]: StreamEntry,
    deliveries: number,
  ): Promise<void> {
    const raw = field(fields, 'data') ?? '';
    if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
      logger.warn(`dead-lettered message ${id}: larger than maxMessageBytes (${maxBytes})`);
      return deadLetter(redis, id, raw.slice(0, 1_024), 'message too large');
    }
    let envelope: Partial<IngestEnvelope>;
    try {
      envelope = JSON.parse(raw) as Partial<IngestEnvelope>;
    } catch {
      logger.warn(`dead-lettered message ${id}: not JSON`);
      return deadLetter(redis, id, raw, 'not JSON');
    }
    const outcome = await handler({ token: envelope?.token, body: envelope });
    if (outcome.status === 'stored') {
      await redis.xack(stream, group, id);
      return;
    }
    const reason = 'reason' in outcome ? outcome.reason : outcome.status;
    if (isDeadLetter(outcome.status) || deliveries >= maxAttempts) {
      logger.warn(`dead-lettered message ${id}: ${reason}`);
      return deadLetter(redis, id, raw, reason);
    }
    // Left pending: taken over after `minIdleMs`.
    logger.warn(`message ${id} will be retried: ${reason}`);
  }

  return {
    kind: 'redis',
    async send(batch, { token, partition }) {
      try {
        const redis = await clientOf();
        const envelope: IngestEnvelope = { ...batch, token, partition };
        await redis.xadd(
          stream,
          'MAXLEN',
          '~',
          options.maxLen ?? 100_000,
          '*',
          'data',
          JSON.stringify(envelope),
        );
        return { status: 'sent' };
      } catch (error) {
        return {
          status: 'retry',
          reason: `redis XADD failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    async listen(handler, logger): Promise<TransportListener> {
      const redis = await clientOf();
      try {
        await redis.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
      } catch (error) {
        if (!String(error instanceof Error ? error.message : error).includes('BUSYGROUP'))
          throw error;
      }
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let running: Promise<void> = Promise.resolve();

      /** Takes over messages idle for `minIdleMs`, each with its delivery count. */
      async function reclaim(): Promise<number> {
        const pending = (await redis.xpending(
          stream,
          group,
          'IDLE',
          minIdleMs,
          '-',
          '+',
          count,
        )) as unknown;
        if (!Array.isArray(pending)) return 0;
        let handled = 0;
        for (const row of pending) {
          if (!Array.isArray(row) || typeof row[0] !== 'string') continue;
          const deliveries = Number(row[3] ?? 1) + 1;
          const claimed = streamEntries(
            await redis.xclaim(stream, group, consumer, minIdleMs, row[0]),
          );
          for (const entry of claimed) {
            await handle(redis, handler, logger, entry, deliveries);
            handled += 1;
          }
        }
        return handled;
      }

      async function tick(): Promise<void> {
        let busy = false;
        try {
          busy = (await reclaim()) >= count;
          const fresh = streamEntries(
            await redis.xreadgroup(
              'GROUP',
              group,
              consumer,
              'COUNT',
              count,
              'STREAMS',
              stream,
              '>',
            ),
          );
          for (const entry of fresh) await handle(redis, handler, logger, entry, 1);
          busy ||= fresh.length >= count;
        } catch (error) {
          logger.warn(`redis consumer: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (stopped) return;
        timer = setTimeout(
          () => {
            running = tick();
          },
          busy ? 0 : pollMs,
        );
        timer.unref?.();
      }

      running = tick();
      return {
        async stop() {
          stopped = true;
          if (timer) clearTimeout(timer);
          await running;
        },
      };
    },
    async close() {
      if (owned && client) await (await client).quit?.();
    },
  };
}
