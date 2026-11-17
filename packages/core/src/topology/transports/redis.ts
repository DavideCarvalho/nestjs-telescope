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
  /** `XINFO GROUPS`, for the periodic trim. Without it (or `xtrim`) the stream is only capped by `maxLen`. */
  xinfo?(...args: (string | number)[]): Promise<unknown>;
  /** `XTRIM ... MINID`, for the periodic trim. */
  xtrim?(...args: (string | number)[]): Promise<unknown>;
  /**
   * A new connection with the same options (ioredis `duplicate()`), for the blocking read.
   * Without it the control plane polls every `pollMs`.
   */
  duplicate?(): RedisStreamClient;
  /** Closes the connection at once (a blocked read is cut short). */
  disconnect?(): void;
  /** ioredis emits connection errors as events. */
  on?(event: 'error', listener: (error: unknown) => void): unknown;
  quit?(): Promise<unknown>;
}

export interface RedisTransportOptions {
  /** ioredis options or a URL; the driver builds (and closes) its own client. */
  connection?: unknown;
  /**
   * An ioredis client to use instead (not closed by the driver). Typed loosely so any ioredis
   * version fits; it must answer the stream commands of {@link RedisStreamClient}. The control
   * plane's blocking read runs on `client.duplicate()`, which the driver opens and closes.
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
  /**
   * Control plane: how long one read waits on the server for a message (`XREADGROUP ... BLOCK`),
   * on a connection of its own (`client.duplicate()`). A message is read as soon as it lands, and
   * an idle control plane sends one read per `blockMs`. `0` turns it off: the stream is polled every
   * `pollMs`. Keep an ioredis `commandTimeout` above it. Default 10 000 ms.
   */
  blockMs?: number;
  /**
   * Control plane: how often the stream is read when the read cannot block (`blockMs: 0`, or a
   * `client` without `duplicate()`); also the pause after a failed read. Default 500 ms.
   */
  pollMs?: number;
  /**
   * Control plane: how often unacknowledged messages are looked at (`XPENDING`) for a take-over;
   * also on start and after a failed read. Default 30 000 ms.
   */
  reclaimIntervalMs?: number;
  /**
   * Control plane: how often messages every consumer group is done with are removed from the
   * stream (`XTRIM MINID ~`), when any was acknowledged since. A pending or unread message is never
   * removed. `0` turns it off (the stream is then only capped by `maxLen`). Default 30 000 ms.
   */
  trimIntervalMs?: number;
  /** Messages read per call. Default 20. */
  count?: number;
  /** A larger message is dead-lettered unread. Default 1 MiB. */
  maxMessageBytes?: number;
  /**
   * Tenant: how often waiting entries are sent when `tenant.intervalMs` is not set. Each send costs
   * an `XADD` here and a read and an ack on the control plane, so fewer, fuller batches cost less (a
   * full batch is sent at once). Default 5 000 ms (the HTTP transport sends every 1 000 ms).
   */
  sendIntervalMs?: number;
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

/** A reply entry as an object: RESP2 gives `[key, value, ...]`, RESP3 a map (or an object). */
function record(entry: unknown): Record<string, unknown> {
  if (entry instanceof Map) return Object.fromEntries(entry);
  if (Array.isArray(entry)) {
    const out: Record<string, unknown> = {};
    for (let i = 0; i + 1 < entry.length; i += 2) out[String(entry[i])] = entry[i + 1];
    return out;
  }
  return (entry ?? {}) as Record<string, unknown>;
}

function parseId(id: string): [bigint, bigint] {
  const [ms = '0', seq = '0'] = id.split('-');
  try {
    return [BigInt(ms || 0), BigInt(seq || 0)];
  } catch {
    return [0n, 0n];
  }
}

/** Orders two stream ids (`<ms>-<seq>`). */
export function compareStreamIds(a: string, b: string): number {
  const [am, as] = parseId(a);
  const [bm, bs] = parseId(b);
  if (am !== bm) return am < bm ? -1 : 1;
  return as === bs ? 0 : as < bs ? -1 : 1;
}

/** The id right after `id`: `MINID` keeps messages from it on. */
function nextId(id: string): string {
  const [ms, seq] = parseId(id);
  return `${ms}-${seq + 1n}`;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Tenants `XADD` each batch to `<prefix>:ingest` (capped with `MAXLEN ~`). The control plane reads
 * it with a consumer group: it waits for new messages with `XREADGROUP ... BLOCK` on a connection
 * of its own (`client.duplicate()`, closed on `stop()`), acknowledges what one read stored (or
 * dead-letters to `<prefix>:ingest:dead`) with a single `XACK`, and every `reclaimIntervalMs` takes
 * over messages left unacknowledged for `minIdleMs` (a control plane that died, or a store that was
 * down), up to `maxAttempts` deliveries. Acknowledged messages are trimmed in bulk every
 * `trimIntervalMs`.
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
  const blockMs = Math.max(0, options.blockMs ?? 10_000);
  const pollMs = options.pollMs ?? 500;
  const reclaimIntervalMs = options.reclaimIntervalMs ?? 30_000;
  const trimIntervalMs = options.trimIntervalMs ?? 30_000;
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

  async function createGroup(redis: RedisStreamClient): Promise<void> {
    try {
      await redis.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
    } catch (error) {
      if (!message(error).includes('BUSYGROUP')) throw error;
    }
  }

  /** Acknowledges the settled messages of one read, all at once. */
  async function ack(redis: RedisStreamClient, ids: string[]): Promise<void> {
    if (ids.length > 0) await redis.xack(stream, group, ...ids);
  }

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
  }

  /** Handles one message. `true` when it is settled (stored or dead-lettered): ack it. */
  async function handle(
    redis: RedisStreamClient,
    handler: IngestHandler,
    logger: TransportLogger,
    [id, fields]: StreamEntry,
    deliveries: number,
  ): Promise<boolean> {
    const raw = field(fields, 'data') ?? '';
    if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
      logger.warn(`dead-lettered message ${id}: larger than maxMessageBytes (${maxBytes})`);
      await deadLetter(redis, id, raw.slice(0, 1_024), 'message too large');
      return true;
    }
    let envelope: Partial<IngestEnvelope>;
    try {
      envelope = JSON.parse(raw) as Partial<IngestEnvelope>;
    } catch {
      logger.warn(`dead-lettered message ${id}: not JSON`);
      await deadLetter(redis, id, raw, 'not JSON');
      return true;
    }
    const outcome = await handler({ token: envelope?.token, body: envelope });
    if (outcome.status === 'stored') return true;
    const reason = 'reason' in outcome ? outcome.reason : outcome.status;
    if (isDeadLetter(outcome.status) || deliveries >= maxAttempts) {
      logger.warn(`dead-lettered message ${id}: ${reason}`);
      await deadLetter(redis, id, raw, reason);
      return true;
    }
    // Left pending: taken over after `minIdleMs`.
    logger.warn(`message ${id} will be retried: ${reason}`);
    return false;
  }

  /** Handles `entries` in order and acks the settled ones in one `XACK`, even if one throws. */
  async function settle(
    redis: RedisStreamClient,
    handler: IngestHandler,
    logger: TransportLogger,
    entries: StreamEntry[],
    deliveries: (id: string) => number,
  ): Promise<void> {
    const done: string[] = [];
    try {
      for (const entry of entries) {
        if (await handle(redis, handler, logger, entry, deliveries(entry[0]))) done.push(entry[0]);
      }
    } finally {
      await ack(redis, done);
    }
  }

  return {
    kind: 'redis',
    sendIntervalMs: options.sendIntervalMs ?? 5_000,
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
        return { status: 'retry', reason: `redis XADD failed: ${message(error)}` };
      }
    },
    async listen(handler, logger): Promise<TransportListener> {
      const redis = await clientOf();
      await createGroup(redis);
      // `XREADGROUP ... BLOCK` ties up its connection: it runs on one of its own.
      const reader =
        blockMs > 0 && typeof redis.duplicate === 'function' ? redis.duplicate() : null;
      // Its connection errors surface through the failed read; without a listener ioredis logs them.
      reader?.on?.('error', () => {});
      let stopped = false;
      let wake: (() => void) | undefined;
      /** 0: the first round looks at what a previous run left pending. */
      let lastReclaim = 0;
      let lastTrim = Date.now();
      /** Something was acknowledged since the last trim. */
      let acked = false;

      /** Waits `ms`, cut short by `stop()`. */
      const pause = (ms: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => wake?.(), ms);
          timer.unref?.();
          wake = () => {
            clearTimeout(timer);
            wake = undefined;
            resolve();
          };
        });

      /** Takes over messages idle for `minIdleMs` (one `XCLAIM`); `true` when a full page came back. */
      async function reclaim(): Promise<boolean> {
        const pending = (await redis.xpending(
          stream,
          group,
          'IDLE',
          minIdleMs,
          '-',
          '+',
          count,
        )) as unknown;
        if (!Array.isArray(pending) || pending.length === 0) return false;
        const deliveries = new Map<string, number>();
        for (const row of pending) {
          if (Array.isArray(row) && typeof row[0] === 'string') {
            deliveries.set(row[0], Number(row[3] ?? 1));
          }
        }
        if (deliveries.size === 0) return false;
        const claimed = streamEntries(
          await redis.xclaim(stream, group, consumer, minIdleMs, ...deliveries.keys()),
        );
        await settle(redis, handler, logger, claimed, (id) => (deliveries.get(id) ?? 0) + 1);
        acked ||= claimed.length > 0;
        return pending.length >= count;
      }

      /**
       * Removes what every consumer group is done with: `XTRIM MINID ~` below the oldest message
       * pending in any group (or, with nothing pending, past the last one a group was handed). A
       * pending or unread message is never removed, so a take-over still finds it.
       */
      async function trim(): Promise<void> {
        lastTrim = Date.now();
        acked = false;
        if (typeof redis.xinfo !== 'function' || typeof redis.xtrim !== 'function') return;
        try {
          let floor: string | null = null;
          const groups = (await redis.xinfo('GROUPS', stream)) as unknown[];
          for (const entry of groups ?? []) {
            const info = record(entry);
            let oldest = nextId(String(info['last-delivered-id'] ?? '0-0'));
            if (Number(info.pending ?? 0) > 0) {
              const summary = (await redis.xpending(stream, String(info.name))) as unknown[];
              if (summary?.[1] != null) oldest = String(summary[1]);
            }
            if (floor === null || compareStreamIds(oldest, floor) < 0) floor = oldest;
          }
          if (floor !== null && floor !== '0-1') await redis.xtrim(stream, 'MINID', '~', floor);
        } catch (error) {
          acked = true;
          logger.warn(`redis consumer: trim failed: ${message(error)}`);
        }
      }

      /** One round: a take-over when due, then one read; `true` when there is more to read now. */
      async function round(): Promise<boolean> {
        let busy = false;
        if (Date.now() - lastReclaim >= reclaimIntervalMs) {
          lastReclaim = Date.now();
          busy = await reclaim();
          // A full page: look again next round.
          if (busy) lastReclaim = 0;
        }
        // Block only when nothing else is waiting to be done.
        const block = reader && !busy ? ['BLOCK', blockMs] : [];
        let reply: unknown;
        try {
          reply = await (reader ?? redis).xreadgroup(
            'GROUP',
            group,
            consumer,
            'COUNT',
            count,
            ...block,
            'STREAMS',
            stream,
            '>',
          );
        } catch (error) {
          // The stream (and its group) went away, say Redis was flushed: create it again.
          if (!stopped && message(error).includes('NOGROUP')) await createGroup(redis);
          throw error;
        }
        if (stopped && reply == null) return false;
        const fresh = streamEntries(reply);
        await settle(redis, handler, logger, fresh, () => 1);
        acked ||= fresh.length > 0;
        if (acked && trimIntervalMs > 0 && Date.now() - lastTrim >= trimIntervalMs) await trim();
        return busy || fresh.length >= count;
      }

      const loop = (async () => {
        while (!stopped) {
          let busy = false;
          try {
            busy = await round();
          } catch (error) {
            if (stopped) break;
            lastReclaim = 0;
            logger.warn(`redis consumer: ${message(error)}`);
            await pause(pollMs);
            continue;
          }
          if (!stopped && !busy && !reader) await pause(pollMs);
        }
      })();

      return {
        async stop() {
          stopped = true;
          wake?.();
          // Cuts a blocked read short; the message in hand finishes on the shared client.
          reader?.disconnect?.();
          await loop;
        },
      };
    },
    async close() {
      if (owned && client) await (await client).quit?.();
    },
  };
}
