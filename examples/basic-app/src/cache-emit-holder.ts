// A tiny bridge between the CacheWatcher's custom `instrument` emitter (called
// once at boot, inside TelescopeModule) and the controller (which fires cache
// hit/miss events per request). Both sides share one holder instance by
// reference, so there's no DI cycle with TelescopeModule's options factory.

import { type WatcherContext } from '@dudousxd/nestjs-telescope';
import { type CacheEventInput, type CustomCacheSource } from '@dudousxd/nestjs-telescope-cache';

export const CACHE_EMIT_HOLDER = Symbol('CACHE_EMIT_HOLDER');

export class CacheEmitHolder {
  private emit: ((event: CacheEventInput) => void) | null = null;

  /** The custom cache source handed to the CacheWatcher; it captures `emit`. */
  source(): CustomCacheSource {
    return {
      instrument: (emit: (event: CacheEventInput) => void, _ctx: WatcherContext): void => {
        this.emit = emit;
      },
    };
  }

  /** Fire one cache lookup (hit or miss) into the active request batch. */
  fireLookup(key: string, hit: boolean): void {
    if (this.emit === null) return;
    this.emit({ operation: 'get', key, hit });
  }
}
