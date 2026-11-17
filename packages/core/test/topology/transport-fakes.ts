// In-memory stand-ins for BullMQ and a Redis stream client, for the transport tests. Not exported
// from the package.
import type { BullmqModule } from '../../src/topology/transports/bullmq.js';
import type { RedisStreamClient } from '../../src/topology/transports/redis.js';

interface FakeJob {
  id: string;
  data: unknown;
  attempts: number;
  attemptsMade: number;
}

/** A BullMQ double: one in-memory queue per name, a worker that runs when `drain()` is called. */
export function fakeBullmq() {
  const queues = new Map<
    string,
    { waiting: FakeJob[]; failed: (FakeJob & { reason: string })[]; ids: Set<string> }
  >();
  const processors = new Map<
    string,
    (job: { data: unknown; attemptsMade: number }) => Promise<unknown>
  >();
  let down = false;
  const queueOf = (name: string) => {
    let q = queues.get(name);
    if (!q) {
      q = { waiting: [], failed: [], ids: new Set() };
      queues.set(name, q);
    }
    return q;
  };
  class UnrecoverableError extends Error {}
  const module: BullmqModule = {
    Queue: class {
      constructor(private readonly name: string) {}
      async add(_name: string, data: unknown, options: Record<string, unknown> = {}) {
        if (down) throw new Error('ECONNREFUSED');
        const q = queueOf(this.name);
        const id = String(options.jobId ?? Math.random());
        if (q.ids.has(id)) return;
        q.ids.add(id);
        // A real queue serializes the job data.
        q.waiting.push({
          id,
          data: JSON.parse(JSON.stringify(data)),
          attempts: Number(options.attempts ?? 1),
          attemptsMade: 0,
        });
      }
      async close() {}
    } as unknown as BullmqModule['Queue'],
    Worker: class {
      constructor(
        name: string,
        processor: (job: { data: unknown; attemptsMade: number }) => Promise<unknown>,
      ) {
        processors.set(name, processor);
      }
      on() {}
      async close() {}
    } as unknown as BullmqModule['Worker'],
    UnrecoverableError,
  };
  return {
    module,
    queues,
    setDown(value: boolean) {
      down = value;
    },
    /** Runs every waiting job once (failed retryable jobs go back to waiting). */
    async drain(name = 'telescope-ingest') {
      const q = queueOf(name);
      const processor = processors.get(name);
      if (!processor) throw new Error(`no worker on ${name}`);
      const jobs = q.waiting.splice(0);
      for (const job of jobs) {
        try {
          await processor(job);
        } catch (error) {
          job.attemptsMade += 1;
          if (error instanceof UnrecoverableError || job.attemptsMade >= job.attempts) {
            q.failed.push({ ...job, reason: (error as Error).message });
          } else {
            q.waiting.push(job);
          }
        }
      }
    },
  };
}

interface Pending {
  consumer: string;
  deliveredAt: number;
  count: number;
}

type Args = (string | number)[];

/**
 * A Redis double for the stream commands the driver sends (RESP2 reply shapes). `duplicate: true`
 * gives the client a `duplicate()` whose `XREADGROUP ... BLOCK` waits for an `XADD` (or the
 * timeout, or `disconnect()`). `commands` counts what was sent, by name.
 */
export function fakeRedis(options: { duplicate?: boolean } = {}) {
  let now = 0;
  let seq = 0;
  let down = false;
  const commands: string[] = [];
  const waiters = new Set<() => void>();
  const streams = new Map<
    string,
    {
      entries: [string, string[]][];
      groups: Map<string, { lastDelivered: string; pending: Map<string, Pending> }>;
    }
  >();
  const streamOf = (key: string) => {
    let s = streams.get(key);
    if (!s) {
      s = { entries: [], groups: new Map() };
      streams.set(key, s);
    }
    return s;
  };
  const num = (id: string) => Number(id.split('-')[0]);
  const check = (name: string) => {
    commands.push(name);
    if (down) throw new Error('ECONNREFUSED');
  };
  const read = (args: Args) => {
    const at = (name: string) => args[args.indexOf(name) + 1];
    const group = String(at('GROUP'));
    const consumer = String(args[args.indexOf('GROUP') + 2]);
    const key = String(at('STREAMS'));
    const s = streamOf(key);
    const g = s.groups.get(group);
    if (!g) throw new Error('NOGROUP No such key or consumer group');
    const fresh = s.entries
      .filter(([id]) => num(id) > num(g.lastDelivered))
      .slice(0, Number(at('COUNT')));
    for (const [id] of fresh) {
      g.lastDelivered = id;
      g.pending.set(id, { consumer, deliveredAt: now, count: 1 });
    }
    return fresh.length === 0 ? null : [[key, fresh]];
  };
  const client: RedisStreamClient = {
    async xadd(key, ...args) {
      check('xadd');
      const star = args.indexOf('*');
      const maxLen = Number(args[2]);
      const s = streamOf(String(key));
      const id = `${++seq}-0`;
      s.entries.push([id, args.slice(star + 1).map(String)]);
      while (s.entries.length > maxLen) s.entries.shift();
      for (const wake of [...waiters]) wake();
      return id;
    },
    async xgroup(_create, key, group) {
      check('xgroup');
      const s = streamOf(String(key));
      if (s.groups.has(String(group)))
        throw new Error('BUSYGROUP Consumer Group name already exists');
      s.groups.set(String(group), { lastDelivered: '0-0', pending: new Map() });
      return 'OK';
    },
    async xreadgroup(...args) {
      check('xreadgroup');
      return read(args);
    },
    async xack(key, group, ...ids) {
      check('xack');
      const g = streamOf(String(key)).groups.get(String(group));
      return ids.filter((id) => g?.pending.delete(String(id))).length;
    },
    async xpending(key, group, ...rest) {
      check('xpending');
      const g = streamOf(String(key)).groups.get(String(group));
      if (rest.length === 0) {
        // Summary form: [count, smallest id, greatest id, consumers].
        const ids = [...(g?.pending.keys() ?? [])].sort((a, b) => num(a) - num(b));
        return [ids.length, ids[0] ?? null, ids.at(-1) ?? null, null];
      }
      const [, minIdle, , , count] = rest;
      if (!g) return [];
      return [...g.pending]
        .filter(([, p]) => now - p.deliveredAt >= Number(minIdle))
        .slice(0, Number(count))
        .map(([id, p]) => [id, p.consumer, now - p.deliveredAt, p.count]);
    },
    async xclaim(key, group, consumer, minIdle, ...ids) {
      check('xclaim');
      const s = streamOf(String(key));
      const out: unknown[] = [];
      for (const id of ids) {
        const p = s.groups.get(String(group))?.pending.get(String(id));
        if (!p || now - p.deliveredAt < Number(minIdle)) continue;
        p.consumer = String(consumer);
        p.deliveredAt = now;
        p.count += 1;
        const entry = s.entries.find(([eid]) => eid === id);
        out.push(entry ?? [String(id), null]);
      }
      return out;
    },
    async xinfo(_groups, key) {
      check('xinfo');
      return [...streamOf(String(key)).groups].map(([name, g]) => [
        'name',
        name,
        'pending',
        g.pending.size,
        'last-delivered-id',
        g.lastDelivered,
      ]);
    },
    async xtrim(key, _minid, _approx, floor) {
      check('xtrim');
      const s = streamOf(String(key));
      const before = s.entries.length;
      s.entries = s.entries.filter(([id]) => num(id) >= num(String(floor)));
      return before - s.entries.length;
    },
  };
  const blockingClient = (): RedisStreamClient => {
    let closed = false;
    const cancels = new Set<() => void>();
    return {
      ...client,
      async xreadgroup(...args) {
        if (closed) throw new Error('Connection is closed.');
        check('xreadgroup');
        const first = read(args);
        const blockAt = args.indexOf('BLOCK');
        if (first !== null || blockAt < 0) return first;
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            clearTimeout(timer);
            waiters.delete(done);
            cancels.delete(cancel);
            resolve();
          };
          const cancel = () => {
            clearTimeout(timer);
            waiters.delete(done);
            reject(new Error('Connection is closed.'));
          };
          const timer = setTimeout(done, Number(args[blockAt + 1]));
          waiters.add(done);
          cancels.add(cancel);
        });
        return read(args);
      },
      disconnect() {
        closed = true;
        for (const cancel of [...cancels]) cancel();
      },
      on() {},
    };
  };
  if (options.duplicate) client.duplicate = blockingClient;
  return {
    client,
    streams,
    commands,
    /** How many of `name` were sent. */
    count(name: string): number {
      return commands.filter((c) => c === name).length;
    },
    advance(ms: number) {
      now += ms;
    },
    setDown(value: boolean) {
      down = value;
    },
    pending(key: string, group = 'telescope'): number {
      return streamOf(key).groups.get(group)?.pending.size ?? 0;
    },
  };
}
