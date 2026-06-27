// packages/cache/src/cache.watcher.spec.ts
import {
  type BatchHandle,
  type BatchOrigin,
  type RecordInput,
  type WatcherContext,
  resolveConfig,
} from '@dudousxd/nestjs-telescope';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { describe, expect, it, vi } from 'vitest';
import {
  type CacheEventInput,
  type CacheLike,
  CacheWatcher,
  type CustomCacheSource,
} from './cache.watcher.js';

interface Harness {
  ctx: WatcherContext;
  recorded: RecordInput[];
}

function makeHarness(
  options: { recordThrows?: boolean; moduleRefGet?: (token: unknown) => unknown } = {},
): Harness {
  const recorded: RecordInput[] = [];
  const moduleRefGet = options.moduleRefGet ?? (() => undefined);
  const ctx: WatcherContext = {
    record: (input) => {
      if (options.recordThrows) throw new Error('recorder boom');
      recorded.push(input);
    },
    runInBatch: async <T>(_origin: BatchOrigin, fn: () => Promise<T>): Promise<T> => fn(),
    beginBatch: (): BatchHandle => ({ id: 'batch', end: () => {} }),
    config: resolveConfig({}),
    moduleRef: { get: moduleRefGet } as unknown as WatcherContext['moduleRef'],
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
    expect(recorded[0]!.content).toEqual({ operation: 'set', key: 'k', hit: null, ttlMs: 60 });
    expect(recorded[0]!.tags).toContain('cache:set');
  });

  it('records a delete via a wrapped del() when the cache exposes one', async () => {
    const store = new Map<string, unknown>([['k', 'v']]);
    const cache = {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => {
        store.set(key, value);
      },
      del: async (key: string) => {
        store.delete(key);
      },
    };
    const { ctx, recorded } = makeHarness();
    new CacheWatcher(cache).register(ctx);

    await cache.del('k');

    expect(store.has('k')).toBe(false); // delete still happened
    expect(recorded[0]!.content).toEqual({ operation: 'delete', key: 'k', hit: null });
    expect(recorded[0]!.tags).toEqual(['cache:delete']);
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

  describe('custom cache source', () => {
    it('records events emitted by a custom source with the right content/familyHash/tags', () => {
      const source: CustomCacheSource = {
        instrument: (emit) => {
          emit({ operation: 'get', key: 'k', hit: true });
          emit({ operation: 'set', key: 'k' });
        },
      };
      const { ctx, recorded } = makeHarness();
      new CacheWatcher(source).register(ctx);

      expect(recorded).toHaveLength(2);

      expect(recorded[0]!.type).toBe('cache');
      expect(recorded[0]!.content).toEqual({ operation: 'get', key: 'k', hit: true });
      expect(recorded[0]!.familyHash).toBe('get:k');
      expect(recorded[0]!.tags).toEqual(['cache:get']);

      expect(recorded[1]!.content).toEqual({ operation: 'set', key: 'k', hit: null });
      expect(recorded[1]!.familyHash).toBe('set:k');
      expect(recorded[1]!.tags).toEqual(['cache:set']);
    });

    it('carries optional store/tier/stale/ttlMs/metadata and surfaces them as tags', () => {
      const source: CustomCacheSource = {
        instrument: (emit) => {
          // A BentoCache-style L2 hit served from grace, on a named store.
          emit({ operation: 'get', key: 'k', hit: true, tier: 'l2', store: 'cache', stale: true });
          emit({ operation: 'set', key: 'k', ttlMs: 86_400_000, store: 'cache' });
          emit({ operation: 'delete', key: 'k', store: 'cache', metadata: { reason: 'evict' } });
        },
      };
      const { ctx, recorded } = makeHarness();
      new CacheWatcher(source).register(ctx);

      expect(recorded[0]!.content).toEqual({
        operation: 'get',
        key: 'k',
        hit: true,
        tier: 'l2',
        store: 'cache',
        stale: true,
      });
      // store/tier/stale become tags so the dashboard can filter by them.
      expect(recorded[0]!.tags).toEqual(['cache:get', 'store:cache', 'tier:l2', 'stale']);

      expect(recorded[1]!.content).toEqual({
        operation: 'set',
        key: 'k',
        hit: null,
        store: 'cache',
        ttlMs: 86_400_000,
      });
      expect(recorded[1]!.tags).toEqual(['cache:set', 'store:cache']);

      expect(recorded[2]!.content).toEqual({
        operation: 'delete',
        key: 'k',
        hit: null,
        store: 'cache',
        metadata: { reason: 'evict' },
      });
      expect(recorded[2]!.familyHash).toBe('delete:k');
    });

    it('omits optional dimensions a simple cache does not supply', () => {
      const source: CustomCacheSource = {
        instrument: (emit) => emit({ operation: 'get', key: 'k', hit: false }),
      };
      const { ctx, recorded } = makeHarness();
      new CacheWatcher(source).register(ctx);
      // No tier/store/stale/ttlMs/metadata keys at all — stays a clean minimal entry.
      expect(recorded[0]!.content).toEqual({ operation: 'get', key: 'k', hit: false });
      expect(recorded[0]!.tags).toEqual(['cache:get']);
    });

    it('normalizes an explicit null hit and a get false hit', () => {
      const source: CustomCacheSource = {
        instrument: (emit) => {
          emit({ operation: 'set', key: 'a', hit: null });
          emit({ operation: 'get', key: 'b', hit: false });
        },
      };
      const { ctx, recorded } = makeHarness();
      new CacheWatcher(source).register(ctx);

      expect(recorded[0]!.content).toEqual({ operation: 'set', key: 'a', hit: null });
      expect(recorded[1]!.content).toEqual({ operation: 'get', key: 'b', hit: false });
    });

    it('passes the WatcherContext as the second arg to instrument', () => {
      let receivedCtx: WatcherContext | undefined;
      const source: CustomCacheSource = {
        instrument: (_emit, ctx) => {
          receivedCtx = ctx;
        },
      };
      const { ctx } = makeHarness();
      new CacheWatcher(source).register(ctx);

      expect(receivedCtx).toBe(ctx);
    });

    it('swallows a record failure inside the custom path (emit stays safe)', () => {
      let emit: ((event: CacheEventInput) => void) | undefined;
      const source: CustomCacheSource = {
        instrument: (emitFn) => {
          emit = emitFn;
        },
      };
      const { ctx } = makeHarness({ recordThrows: true });
      new CacheWatcher(source).register(ctx);

      expect(emit).toBeDefined();
      expect(() => emit!({ operation: 'get', key: 'k', hit: true })).not.toThrow();
    });

    it('does not auto-patch anything for a custom source', () => {
      let getCalls = 0;
      let setCalls = 0;
      const source: CustomCacheSource & CacheLike = {
        instrument: () => {},
        get: async (key) => {
          getCalls += 1;
          return key;
        },
        set: async () => {
          setCalls += 1;
        },
      };
      const { ctx, recorded } = makeHarness();
      const originalGet = source.get;
      const originalSet = source.set;
      new CacheWatcher(source).register(ctx);

      // The custom path takes precedence (instrument present), so get/set stay untouched.
      expect(source.get).toBe(originalGet);
      expect(source.set).toBe(originalSet);
      expect(recorded).toHaveLength(0);
      expect(getCalls).toBe(0);
      expect(setCalls).toBe(0);
    });
  });

  describe('auto-discovery (no-arg)', () => {
    it('discovers CACHE_MANAGER via moduleRef and instruments it', async () => {
      const cache = fakeCache({ user: { id: 1 } });
      const { ctx, recorded } = makeHarness({
        moduleRefGet: (token) => (token === CACHE_MANAGER ? cache : undefined),
      });
      await new CacheWatcher().register(ctx);

      const value = await cache.get('user');

      expect(value).toEqual({ id: 1 });
      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.content).toEqual({ operation: 'get', key: 'user', hit: true });
    });

    it('captures a set via the discovered CACHE_MANAGER', async () => {
      const cache = fakeCache();
      const { ctx, recorded } = makeHarness({
        moduleRefGet: (token) => (token === CACHE_MANAGER ? cache : undefined),
      });
      await new CacheWatcher().register(ctx);

      await cache.set('k', 'v', 60);

      expect(recorded[0]!.content).toEqual({ operation: 'set', key: 'k', hit: null, ttlMs: 60 });
    });

    it('warns and no-ops when CACHE_MANAGER is not found (never throws)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { ctx, recorded } = makeHarness({ moduleRefGet: () => undefined });

      await expect(new CacheWatcher().register(ctx)).resolves.toBeUndefined();
      expect(recorded).toHaveLength(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain('CACHE_MANAGER not found');

      warn.mockRestore();
    });

    it('warns when the resolved CACHE_MANAGER is not a CacheLike', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { ctx, recorded } = makeHarness({
        moduleRefGet: (token) => (token === CACHE_MANAGER ? { notACache: true } : undefined),
      });

      await expect(new CacheWatcher().register(ctx)).resolves.toBeUndefined();
      expect(recorded).toHaveLength(0);
      expect(warn).toHaveBeenCalledTimes(1);

      warn.mockRestore();
    });

    it('survives a moduleRef.get that throws (no throw, warns)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { ctx } = makeHarness({
        moduleRefGet: () => {
          throw new Error('container boom');
        },
      });

      await expect(new CacheWatcher().register(ctx)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);

      warn.mockRestore();
    });
  });

  describe('optional-peer safety (Bento-only path)', () => {
    it('constructs and registers the { instrument } path without touching @nestjs/cache-manager', () => {
      // Bento-only consumers don't install @nestjs/cache-manager. The custom
      // source path must neither import it (top-level import is gone) nor hit
      // the dynamic-import auto-discovery branch — register() returns void here.
      let emit: ((event: CacheEventInput) => void) | undefined;
      const source: CustomCacheSource = {
        instrument: (emitFn) => {
          emit = emitFn;
        },
      };
      const { ctx, recorded } = makeHarness();

      const result = new CacheWatcher(source).register(ctx);

      // Custom path is synchronous (no dynamic import), so register returns void.
      expect(result).toBeUndefined();
      expect(emit).toBeDefined();
      emit!({ operation: 'get', key: 'k', hit: true });
      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.content).toEqual({ operation: 'get', key: 'k', hit: true });
    });
  });
});
