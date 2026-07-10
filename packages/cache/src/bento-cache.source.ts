// packages/cache/src/bento-cache.source.ts
//
// BentoCache (https://bentocache.dev) exposes no post-construction event API:
// consumers construct their own Node `EventEmitter`, pass it to
// `new BentoCache({ emitter })`, and BentoCache emits its lifecycle events onto
// it. Every host that wants Telescope coverage for BentoCache therefore has to
// hand-write the same ~45-line mapping from bento's events to
// `CacheEventInput`. `bentoCacheSource` is that mapping, packaged as a
// {@link CustomCacheSource}.
import type { CacheEventInput, CustomCacheSource } from './cache.watcher.js';

/**
 * The minimal structural surface `bentoCacheSource` needs from an event
 * emitter: `on(event, listener)`. A Node `EventEmitter` satisfies this
 * trivially, but nothing here imports `node:events` or `bentocache` — the
 * dependency is purely structural so this package never needs `bentocache` as
 * even a dev dependency.
 */
export interface BentoCacheEmitterLike {
  // The listener rest-param is `any[]` ON PURPOSE — it mirrors Node's own
  // EventEmitter listener signature. Stricter variants (`never`, `unknown`)
  // are NOT assignable from the generic `EventEmitter<any>` modern
  // @types/node exposes, which is exactly what consumers pass here.
  // biome-ignore lint/suspicious/noExplicitAny: structural boundary matching Node's EventEmitter
  on(event: string, listener: (...args: any[]) => void): unknown;
}

/**
 * Payload shapes mirroring BentoCache's own emitter events. Kept local (not
 * imported from `bentocache`) so this package has zero dependency — direct or
 * dev — on BentoCache. Fields match BentoCache's documented emitter payloads;
 * verify against your installed `bentocache` version's types/docs if in doubt,
 * since BentoCache does not publish a versioned event-payload contract.
 *
 * All fields are optional: a malformed or future-shaped payload (fields
 * renamed/dropped upstream) must never throw, only map to fewer dimensions.
 */
export interface BentoCacheHitPayload {
  key?: string;
  store?: string;
  /** Cache layer that served the hit, e.g. `'l1'` / `'l2'`. Mapped to `tier`. */
  layer?: string;
  /** Whether the value was served stale (grace period). Mapped to `stale`. */
  graced?: boolean;
}

export interface BentoCacheMissPayload {
  key?: string;
  store?: string;
}

export interface BentoCacheWrittenPayload {
  key?: string;
  store?: string;
}

export interface BentoCacheDeletedPayload {
  key?: string;
  store?: string;
}

export interface BentoCacheClearedPayload {
  store?: string;
}

/** The key used for `cache:cleared` events, which have no single key of their
 *  own — BentoCache clears an entire store. */
const CLEAR_KEY = '*';

/** `key`/`store` are optional on every bento payload we map (a malformed event
 *  must never throw); default a missing `key` to an empty string rather than
 *  dropping the entry, so a bug upstream still surfaces something in
 *  Telescope instead of silently vanishing. */
function baseEvent(
  operation: CacheEventInput['operation'],
  key: string | undefined,
  store: string | undefined,
): CacheEventInput {
  const event: CacheEventInput = { operation, key: key ?? '' };
  if (store !== undefined) event.store = store;
  return event;
}

/**
 * Wraps a BentoCache-compatible event emitter as a {@link CustomCacheSource}
 * so `CacheWatcher` can capture BentoCache's `get`/`set`/`delete`/`clear`
 * operations without BentoCache being a dependency of this package.
 *
 * Maps BentoCache's emitter events onto {@link CacheEventInput}:
 * - `cache:hit` → `{ operation: 'get', hit: true }`, `layer`→`tier`, `graced`→`stale`
 * - `cache:miss` → `{ operation: 'get', hit: false }`
 * - `cache:written` → `{ operation: 'set' }`
 * - `cache:deleted` → `{ operation: 'delete' }`
 * - `cache:cleared` → `{ operation: 'clear', key: '*' }` (bento clears a whole store, not one key)
 *
 * A malformed/partial payload (missing fields) is mapped defensively — missing
 * optional fields are simply omitted from the emitted event, never thrown.
 *
 * @example
 * ```ts
 * import { EventEmitter } from 'node:events';
 * import { BentoCache } from 'bentocache';
 * import { CacheWatcher } from '@dudousxd/nestjs-telescope-cache';
 * import { bentoCacheSource } from '@dudousxd/nestjs-telescope-cache';
 *
 * const bentoEmitter = new EventEmitter();
 * const bento = new BentoCache({ ..., emitter: bentoEmitter });
 *
 * TelescopeModule.forRoot({
 *   watchers: [new CacheWatcher(bentoCacheSource(bentoEmitter))],
 * });
 * ```
 */
export function bentoCacheSource(emitter: BentoCacheEmitterLike): CustomCacheSource {
  return {
    instrument(emit: (event: CacheEventInput) => void): void {
      emitter.on('cache:hit', (payload: BentoCacheHitPayload) => {
        const event = baseEvent('get', payload?.key, payload?.store);
        event.hit = true;
        if (payload?.layer !== undefined) event.tier = payload.layer;
        if (payload?.graced !== undefined) event.stale = payload.graced;
        emit(event);
      });

      emitter.on('cache:miss', (payload: BentoCacheMissPayload) => {
        const event = baseEvent('get', payload?.key, payload?.store);
        event.hit = false;
        emit(event);
      });

      emitter.on('cache:written', (payload: BentoCacheWrittenPayload) => {
        emit(baseEvent('set', payload?.key, payload?.store));
      });

      emitter.on('cache:deleted', (payload: BentoCacheDeletedPayload) => {
        emit(baseEvent('delete', payload?.key, payload?.store));
      });

      emitter.on('cache:cleared', (payload: BentoCacheClearedPayload) => {
        emit(baseEvent('clear', CLEAR_KEY, payload?.store));
      });
    },
  };
}
