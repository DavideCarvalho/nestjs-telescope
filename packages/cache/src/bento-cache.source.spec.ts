// packages/cache/src/bento-cache.source.spec.ts
import { EventEmitter } from 'node:events';
import type {
  BatchHandle,
  BatchOrigin,
  RecordInput,
  WatcherContext,
} from '@dudousxd/nestjs-telescope';
import { resolveConfig } from '@dudousxd/nestjs-telescope';
import { describe, expect, it } from 'vitest';
import { bentoCacheSource } from './bento-cache.source.js';
import { CacheWatcher } from './cache.watcher.js';

interface Harness {
  ctx: WatcherContext;
  recorded: RecordInput[];
}

function makeHarness(): Harness {
  const recorded: RecordInput[] = [];
  const ctx: WatcherContext = {
    record: (input) => {
      recorded.push(input);
    },
    runInBatch: async <T>(_origin: BatchOrigin, fn: () => Promise<T>): Promise<T> => fn(),
    beginBatch: (): BatchHandle => ({ id: 'batch', end: () => {} }),
    config: resolveConfig({}),
    moduleRef: { get: () => undefined } as unknown as WatcherContext['moduleRef'],
  };
  return { ctx, recorded };
}

describe('bentoCacheSource', () => {
  it('a real Node EventEmitter satisfies the structural BentoCacheEmitterLike type', () => {
    const emitter = new EventEmitter();
    const source = bentoCacheSource(emitter);
    const { ctx, recorded } = makeHarness();

    new CacheWatcher(source).register(ctx);
    emitter.emit('cache:hit', { key: 'k', store: 'cache', layer: 'l1', graced: false });

    expect(recorded).toHaveLength(1);
  });

  it('maps cache:hit to a get with hit:true, layer->tier, graced->stale', () => {
    const emitter = new EventEmitter();
    const { ctx, recorded } = makeHarness();
    new CacheWatcher(bentoCacheSource(emitter)).register(ctx);

    emitter.emit('cache:hit', { key: 'user:1', store: 'cache', layer: 'l2', graced: true });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.content).toEqual({
      operation: 'get',
      key: 'user:1',
      hit: true,
      store: 'cache',
      tier: 'l2',
      stale: true,
    });
  });

  it('maps cache:miss to a get with hit:false', () => {
    const emitter = new EventEmitter();
    const { ctx, recorded } = makeHarness();
    new CacheWatcher(bentoCacheSource(emitter)).register(ctx);

    emitter.emit('cache:miss', { key: 'user:1', store: 'cache' });

    expect(recorded[0]!.content).toEqual({
      operation: 'get',
      key: 'user:1',
      hit: false,
      store: 'cache',
    });
  });

  it('maps cache:written to a set', () => {
    const emitter = new EventEmitter();
    const { ctx, recorded } = makeHarness();
    new CacheWatcher(bentoCacheSource(emitter)).register(ctx);

    emitter.emit('cache:written', { key: 'user:1', store: 'cache' });

    expect(recorded[0]!.content).toEqual({
      operation: 'set',
      key: 'user:1',
      hit: null,
      store: 'cache',
    });
  });

  it('maps cache:deleted to a delete', () => {
    const emitter = new EventEmitter();
    const { ctx, recorded } = makeHarness();
    new CacheWatcher(bentoCacheSource(emitter)).register(ctx);

    emitter.emit('cache:deleted', { key: 'user:1', store: 'cache' });

    expect(recorded[0]!.content).toEqual({
      operation: 'delete',
      key: 'user:1',
      hit: null,
      store: 'cache',
    });
  });

  it('maps cache:cleared to a clear with key "*" (bento clears a whole store, not one key)', () => {
    const emitter = new EventEmitter();
    const { ctx, recorded } = makeHarness();
    new CacheWatcher(bentoCacheSource(emitter)).register(ctx);

    emitter.emit('cache:cleared', { store: 'cache' });

    expect(recorded[0]!.content).toEqual({
      operation: 'clear',
      key: '*',
      hit: null,
      store: 'cache',
    });
  });

  it('does not throw on a malformed/empty payload and drops missing optional fields', () => {
    const emitter = new EventEmitter();
    const { ctx, recorded } = makeHarness();
    new CacheWatcher(bentoCacheSource(emitter)).register(ctx);

    expect(() => {
      emitter.emit('cache:hit', undefined as any);
      emitter.emit('cache:miss', {} as any);
      emitter.emit('cache:cleared', undefined as any);
    }).not.toThrow();

    expect(recorded).toHaveLength(3);
    expect(recorded[0]!.content).toEqual({ operation: 'get', key: '', hit: true });
    expect(recorded[1]!.content).toEqual({ operation: 'get', key: '', hit: false });
    expect(recorded[2]!.content).toEqual({ operation: 'clear', key: '*', hit: null });
  });

  it('surfaces store/tier/stale as tags, matching the CustomCacheSource contract', () => {
    const emitter = new EventEmitter();
    const { ctx, recorded } = makeHarness();
    new CacheWatcher(bentoCacheSource(emitter)).register(ctx);

    emitter.emit('cache:hit', { key: 'k', store: 'cache', layer: 'l1', graced: true });

    expect(recorded[0]!.tags).toEqual(['cache:get', 'store:cache', 'tier:l1', 'stale']);
  });
});
