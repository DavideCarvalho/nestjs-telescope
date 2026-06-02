// packages/cache/src/cache.watcher.spec.ts
import {
  type BatchHandle,
  type BatchOrigin,
  type RecordInput,
  type WatcherContext,
  resolveConfig,
} from '@dudousxd/nestjs-telescope';
import { describe, expect, it } from 'vitest';
import { type CacheLike, CacheWatcher } from './cache.watcher.js';

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

/** A fake cache-manager Cache backed by a Map. */
function fakeCache(initial: Record<string, unknown> = {}): CacheLike {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get: async (key) => store.get(key),
    set: async (key, value) => {
      store.set(key, value);
    },
  };
}

describe('CacheWatcher', () => {
  it('has type "cache"', () => {
    expect(new CacheWatcher(fakeCache()).type).toBe('cache');
  });

  it('records a get hit and returns the value unchanged', async () => {
    const cache = fakeCache({ user: { id: 1 } });
    const { ctx, recorded } = makeHarness();
    new CacheWatcher(cache).register(ctx);

    const value = await cache.get('user');

    expect(value).toEqual({ id: 1 });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.type).toBe('cache');
    expect(recorded[0]!.content).toEqual({ operation: 'get', key: 'user', hit: true });
  });

  it('records a get miss when the value is undefined', async () => {
    const cache = fakeCache();
    const { ctx, recorded } = makeHarness();
    new CacheWatcher(cache).register(ctx);

    const value = await cache.get('missing');

    expect(value).toBeUndefined();
    expect(recorded[0]!.content).toEqual({ operation: 'get', key: 'missing', hit: false });
  });

  it('records a get miss when the value is null', async () => {
    const cache = fakeCache({ nulled: null });
    const { ctx, recorded } = makeHarness();
    new CacheWatcher(cache).register(ctx);

    await cache.get('nulled');

    expect(recorded[0]!.content).toMatchObject({ hit: false });
  });

  it('records a set with hit:null', async () => {
    const cache = fakeCache();
    const { ctx, recorded } = makeHarness();
    new CacheWatcher(cache).register(ctx);

    await cache.set('k', 'v', 60);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.content).toEqual({ operation: 'set', key: 'k', hit: null });
    expect(recorded[0]!.tags).toContain('cache:set');
  });

  it('re-throws errors from the underlying cache', async () => {
    const cache: CacheLike = {
      get: async () => {
        throw new Error('redis down');
      },
      set: async () => {
        throw new Error('redis down');
      },
    };
    const { ctx } = makeHarness();
    new CacheWatcher(cache).register(ctx);

    await expect(cache.get('k')).rejects.toThrow('redis down');
    await expect(cache.set('k', 'v')).rejects.toThrow('redis down');
  });

  it('wraps get/set exactly once across repeated register calls', async () => {
    const cache = fakeCache({ k: 1 });
    const { ctx, recorded } = makeHarness();
    const watcher = new CacheWatcher(cache);
    watcher.register(ctx);
    watcher.register(ctx);

    await cache.get('k');

    expect(recorded).toHaveLength(1);
  });

  it('never corrupts the cache outcome when ctx.record throws', async () => {
    const cache = fakeCache({ k: 'v' });
    const { ctx } = makeHarness({ recordThrows: true });
    new CacheWatcher(cache).register(ctx);

    await expect(cache.get('k')).resolves.toBe('v');
  });
});
