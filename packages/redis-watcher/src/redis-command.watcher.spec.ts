// packages/redis-watcher/src/redis-command.watcher.spec.ts
//
// The watcher wraps `client.sendCommand` — the single funnel every command goes
// through on a real ioredis client. We exercise it against a minimal fake that
// honours that contract (a `sendCommand(command)` that returns a promise, where
// `command` carries `.name` + `.args`). ioredis-mock dispatches commands as
// direct own-property methods and never funnels through `sendCommand`, so it
// can't drive this wrap; the fake faithfully models the real funnel instead.
//
import {
  type BatchHandle,
  type BatchOrigin,
  type RecordInput,
  type WatcherContext,
  resolveConfig,
} from '@dudousxd/nestjs-telescope';
import { describe, expect, it } from 'vitest';
import {
  type CustomRedisSource,
  type RedisClientLike,
  type RedisCommandLike,
  RedisCommandWatcher,
} from './redis-command.watcher.js';

interface Harness {
  ctx: WatcherContext;
  recorded: RecordInput[];
}

function makeHarness(options: { recordThrows?: boolean } = {}): Harness {
  const recorded: RecordInput[] = [];
  const ctx: WatcherContext = {
    record: (input) => {
      if (options.recordThrows) throw new Error('recorder boom');
      recorded.push(input);
    },
    runInBatch: async <T>(_origin: BatchOrigin, fn: () => Promise<T>): Promise<T> => fn(),
    beginBatch: (): BatchHandle => ({ id: 'batch', end: () => {} }),
    config: resolveConfig({}),
    moduleRef: { get: () => undefined } as unknown as WatcherContext['moduleRef'],
  };
  return { ctx, recorded };
}

/** A fake ioredis-style client: a `sendCommand` funnel + a tiny Map store, with
 *  ergonomic `get`/`set` that route through `sendCommand` like the real client. */
function fakeClient(): RedisClientLike & {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<unknown>;
  sendCommandCalls: number;
} {
  const store = new Map<string, unknown>();
  const client = {
    sendCommandCalls: 0,
    sendCommand(command: RedisCommandLike): unknown {
      client.sendCommandCalls += 1;
      const name = command.name.toLowerCase();
      if (name === 'set') {
        store.set(String(command.args[0]), command.args[1]);
        return Promise.resolve('OK');
      }
      if (name === 'get') {
        return Promise.resolve(store.get(String(command.args[0])) ?? null);
      }
      return Promise.resolve(null);
    },
    get(key: string): Promise<unknown> {
      return Promise.resolve(client.sendCommand({ name: 'get', args: [key] }));
    },
    set(key: string, value: unknown): Promise<unknown> {
      return Promise.resolve(client.sendCommand({ name: 'set', args: [key, value] }));
    },
  };
  return client;
}

describe('RedisCommandWatcher', () => {
  it('has type "redis"', () => {
    expect(new RedisCommandWatcher(fakeClient()).type).toBe('redis');
  });

  it('records a command with name + args + duration', async () => {
    const client = fakeClient();
    const { ctx, recorded } = makeHarness();
    new RedisCommandWatcher(client).register(ctx);

    await client.set('user:1', 'ada');
    await client.get('user:1');

    const get = recorded.find((entry) => (entry.content as { command: string }).command === 'GET');
    expect(get).toBeDefined();
    expect(get!.type).toBe('redis');
    const content = get!.content as { command: string; args: unknown[]; durationMs: number | null };
    expect(content.command).toBe('GET');
    expect(content.args).toEqual(['user:1']);
    expect(typeof content.durationMs).toBe('number');
    expect(get!.tags).toContain('redis:GET');
  });

  it('returns the underlying result unchanged', async () => {
    const client = fakeClient();
    const { ctx } = makeHarness();
    new RedisCommandWatcher(client).register(ctx);

    expect(await client.set('k', 'v')).toBe('OK');
    expect(await client.get('k')).toBe('v');
  });

  it('restores the original sendCommand on cleanup', async () => {
    const client = fakeClient();
    const { ctx, recorded } = makeHarness();
    const watcher = new RedisCommandWatcher(client);
    watcher.register(ctx);
    watcher.cleanup();

    await client.set('after', 'cleanup');

    expect(recorded).toHaveLength(0);
  });

  it('wraps sendCommand exactly once across repeated register calls', async () => {
    const client = fakeClient();
    const { ctx, recorded } = makeHarness();
    const watcher = new RedisCommandWatcher(client);
    watcher.register(ctx);
    watcher.register(ctx);

    await client.set('k', 'v');

    const sets = recorded.filter(
      (entry) => (entry.content as { command: string }).command === 'SET',
    );
    expect(sets).toHaveLength(1);
  });

  it('never alters a command outcome when ctx.record throws', async () => {
    const client = fakeClient();
    const { ctx } = makeHarness({ recordThrows: true });
    new RedisCommandWatcher(client).register(ctx);

    await client.set('k', 'v');
    await expect(client.get('k')).resolves.toBe('v');
  });

  it('supports the { instrument } construction form', async () => {
    const client = fakeClient();
    const { ctx, recorded } = makeHarness();
    const source: CustomRedisSource = {
      instrument: (use) => {
        use(client);
      },
    };
    new RedisCommandWatcher(source).register(ctx);

    await client.set('k', 'v');

    expect(recorded.length).toBeGreaterThan(0);
    expect((recorded[0]!.content as { command: string }).command).toBe('SET');
  });

  it('degrades to a no-op when the client lacks sendCommand', () => {
    const { ctx, recorded } = makeHarness();
    const notAClient = {} as unknown as RedisClientLike;
    expect(() => new RedisCommandWatcher(notAClient).register(ctx)).not.toThrow();
    expect(recorded).toHaveLength(0);
  });
});
