// packages/cache/src/cache.watcher.ts
import {
  EntryType,
  type RecordInput,
  type Watcher,
  type WatcherContext,
} from '@dudousxd/nestjs-telescope';

/** The structural cache surface we wrap — covers `cache-manager` v5 /
 *  `@nestjs/cache-manager` `Cache`. Kept minimal so signature drift between
 *  versions doesn't break the wrap. */
export interface CacheLike {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttl?: number): Promise<unknown>;
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
 * @remarks
 * Patching is per-instance and idempotent (a `Symbol.for` marker).
 */
export class CacheWatcher implements Watcher {
  readonly type = EntryType.Cache;
  private readonly cache: CacheLike;

  constructor(cache: CacheLike) {
    this.cache = cache;
  }

  register(ctx: WatcherContext): void {
    const cache = this.cache as CacheLike & { [PATCHED]?: boolean };
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
