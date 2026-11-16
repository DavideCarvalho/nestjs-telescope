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

/** A Redis double for the stream commands the driver sends (RESP2 reply shapes). */
export function fakeRedis() {
  let now = 0;
  let seq = 0;
  let down = false;
  const streams = new Map<
    string,
    {
      entries: [string, string[]][];
      groups: Map<string, { next: number; pending: Map<string, Pending> }>;
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
  const check = () => {
    if (down) throw new Error('ECONNREFUSED');
  };
  const client: RedisStreamClient = {
    async xadd(key, ...args) {
      check();
      const star = args.indexOf('*');
      const maxLen = Number(args[2]);
      const s = streamOf(String(key));
      const id = `${++seq}-0`;
      s.entries.push([id, args.slice(star + 1).map(String)]);
      while (s.entries.length > maxLen) s.entries.shift();
      return id;
    },
    async xgroup(_create, key, group) {
      check();
      const s = streamOf(String(key));
      if (s.groups.has(String(group)))
        throw new Error('BUSYGROUP Consumer Group name already exists');
      s.groups.set(String(group), { next: 0, pending: new Map() });
      return 'OK';
    },
    async xreadgroup(_g, group, consumer, _c, count, _s, key) {
      check();
      const s = streamOf(String(key));
      const g = s.groups.get(String(group));
      if (!g) throw new Error('NOGROUP');
      const fresh = s.entries.slice(g.next, g.next + Number(count));
      g.next += fresh.length;
      for (const [id] of fresh)
        g.pending.set(id, { consumer: String(consumer), deliveredAt: now, count: 1 });
      return fresh.length === 0 ? null : [[String(key), fresh]];
    },
    async xack(key, group, id) {
      check();
      return streamOf(String(key)).groups.get(String(group))?.pending.delete(String(id)) ? 1 : 0;
    },
    async xpending(key, group, _idle, minIdle, _a, _b, count) {
      check();
      const g = streamOf(String(key)).groups.get(String(group));
      if (!g) return [];
      return [...g.pending]
        .filter(([, p]) => now - p.deliveredAt >= Number(minIdle))
        .slice(0, Number(count))
        .map(([id, p]) => [id, p.consumer, now - p.deliveredAt, p.count]);
    },
    async xclaim(key, group, consumer, minIdle, id) {
      check();
      const s = streamOf(String(key));
      const p = s.groups.get(String(group))?.pending.get(String(id));
      if (!p || now - p.deliveredAt < Number(minIdle)) return [];
      p.consumer = String(consumer);
      p.deliveredAt = now;
      p.count += 1;
      const entry = s.entries.find(([eid]) => eid === id);
      return [entry ?? [String(id), null]];
    },
  };
  return {
    client,
    streams,
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
