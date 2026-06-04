// packages/cache/src/cache.watcher.ts
import {
  EntryType,
  type RecordInput,
  type Watcher,
  type WatcherContext,
} from '@dudousxd/nestjs-telescope';
import { CACHE_MANAGER } from '@nestjs/cache-manager';

/** The structural cache surface we wrap — covers `cache-manager` v5 /
 *  `@nestjs/cache-manager` `Cache`. Kept minimal so signature drift between
 *  versions doesn't break the wrap. */
export interface CacheLike {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttl?: number): Promise<unknown>;
}

/** An event a custom cache emits into Telescope. `hit` is `true`/`false` for
 *  reads and `null` (or omitted) for writes. */
export interface CacheEventInput {
  operation: 'get' | 'set';
  key: string;
  hit?: boolean | null;
}

/**
 * Custom cache source. Instead of auto-patching `get`/`set`, the host wires its
 * own cache's native events into Telescope.
 *
 * `instrument` is called exactly once at `register()` with:
 * - `emit`: records a cache entry, correlated to the active request/job batch
 *   (same family-hash / tags / error-swallowing as the auto-patch path).
 * - `ctx`: the {@link WatcherContext}, so the host can resolve its cache from
 *   `ctx.moduleRef` and subscribe to its native events.
 *
 * The host owns the subscription; the watcher patches nothing on this path.
 */
export interface CustomCacheSource {
  instrument(emit: (event: CacheEventInput) => void, ctx: WatcherContext): void;
}

/** Narrows a constructor argument to a {@link CustomCacheSource} (custom path)
 *  vs a {@link CacheLike} (auto-patch path) by the presence of `instrument`. */
function isCustomCacheSource(source: CacheLike | CustomCacheSource): source is CustomCacheSource {
  return 'instrument' in source && typeof source.instrument === 'function';
}

/** Narrows an unknown (e.g. a provider resolved from the Nest container) to a
 *  {@link CacheLike} by the presence of `get`/`set` functions. */
function isCacheLike(value: unknown): value is CacheLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { get?: unknown; set?: unknown };
  return typeof candidate.get === 'function' && typeof candidate.set === 'function';
}

/** Marks a cache instance whose `get`/`set` we've already wrapped, so repeated
 *  registration (or two watchers sharing it) never double-wraps. */
const PATCHED = Symbol.for('@dudousxd/nestjs-telescope:cachePatched');

/**
 * Captures cache `get`/`set` operations and correlates each to the request/job
 * that issued it.
 *
 * ## How it works
 * The host hands the watcher its `cache-manager` `Cache` instance; `register()`
 * patches that instance's `get` and `set`. Both run in the caller's async
 * context (the active request/job ALS scope), so each captured entry lands in
 * the right batch — no batch is opened here.
 *
 * - `get` awaits the original, records `{ operation:'get', key, hit }` where
 *   `hit` is `true` when the value is neither `undefined` nor `null`, and
 *   returns the value unchanged.
 * - `set` records `{ operation:'set', key, hit:null }` and awaits the original.
 *
 * Errors from the underlying cache are always re-thrown; recording failures are
 * swallowed so a telescope error can never alter the cache's outcome.
 *
 * ## Custom caches
 * A cache that isn't a `cache-manager`-style `Cache` (e.g. BentoCache) can be
 * instrumented by passing a {@link CustomCacheSource} instead: its `instrument`
 * hook wires the cache's native events into Telescope via an `emit` callback.
 * Nothing is auto-patched on this path — the host owns the subscription.
 *
 * @remarks
 * Patching is per-instance and idempotent (a `Symbol.for` marker).
 */
export class CacheWatcher implements Watcher {
  readonly type = EntryType.Cache;
  private readonly source: CacheLike | CustomCacheSource | undefined;

  constructor(source?: CacheLike | CustomCacheSource) {
    this.source = source;
  }

  register(ctx: WatcherContext): void {
    // No-arg form: auto-discover the standard `@nestjs/cache-manager`
    // CACHE_MANAGER from the Nest container and patch it.
    if (this.source === undefined) {
      const discovered = this.resolveStandardCache(ctx);
      if (!discovered) {
        console.warn(
          'CacheWatcher: no cache provided and CACHE_MANAGER not found — ' +
            'set a cache or use { instrument }',
        );
        return;
      }
      this.patchCache(discovered, ctx);
      return;
    }

    if (isCustomCacheSource(this.source)) {
      this.source.instrument((event) => {
        this.safeRecord(ctx, {
          operation: event.operation,
          key: event.key,
          hit: event.hit ?? null,
        });
      }, ctx);
      return;
    }

    this.patchCache(this.source, ctx);
  }

  /** Resolve the standard `@nestjs/cache-manager` `CACHE_MANAGER` provider from
   *  the Nest container, narrowed to a {@link CacheLike}. Returns null when the
   *  provider is absent or isn't a CacheLike. Defensive: a strict-resolution
   *  throw degrades to null (never propagates). */
  private resolveStandardCache(ctx: WatcherContext): CacheLike | null {
    try {
      const found = ctx.moduleRef.get(CACHE_MANAGER, { strict: false });
      return isCacheLike(found) ? found : null;
    } catch {
      return null;
    }
  }

  /** Patch a {@link CacheLike}'s `get`/`set` to record each operation. Shared by
   *  the explicit `new CacheWatcher(cache)` form and the no-arg auto-discovery
   *  form. Per-instance and idempotent via the {@link PATCHED} marker. */
  private patchCache(target: CacheLike, ctx: WatcherContext): void {
    const cache = target as CacheLike & { [PATCHED]?: boolean };
    if (cache[PATCHED]) return;
    cache[PATCHED] = true;

    const watcher = this;
    const originalGet = cache.get.bind(cache);
    const originalSet = cache.set.bind(cache);

    cache.get = async function patchedGet(key: string): Promise<unknown> {
      const result = await originalGet(key);
      watcher.safeRecord(ctx, {
        operation: 'get',
        key,
        hit: result !== undefined && result !== null,
      });
      return result;
    };

    cache.set = async function patchedSet(
      key: string,
      value: unknown,
      ttl?: number,
    ): Promise<unknown> {
      watcher.safeRecord(ctx, { operation: 'set', key, hit: null });
      return ttl === undefined ? originalSet(key, value) : originalSet(key, value, ttl);
    };
  }

  /** Hand a cache entry to the Recorder, swallowing any record failure so a
   *  telescope error can never alter the cache operation's outcome. */
  private safeRecord(
    ctx: WatcherContext,
    content: { operation: 'get' | 'set'; key: string; hit: boolean | null },
  ): void {
    try {
      const input: RecordInput = {
        type: EntryType.Cache,
        familyHash: `${content.operation}:${content.key}`,
        content,
        tags: [`cache:${content.operation}`],
      };
      ctx.record(input);
    } catch (recordError) {
      const message = recordError instanceof Error ? recordError.message : String(recordError);
      console.error(`CacheWatcher: failed to record cache entry: ${message}`);
    }
  }
}
