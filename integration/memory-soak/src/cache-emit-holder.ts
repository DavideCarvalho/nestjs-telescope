// integration/memory-soak/src/cache-emit-holder.ts
//
// Decouples the CacheWatcher's custom `instrument` (called once at register,
// inside TelescopeModule's bootstrap) from the controller (which fires emits per
// request). Both sides share one holder instance by reference — no DI cycle
// between TelescopeModule's async options factory and AppModule's providers.

import { type WatcherContext } from '@dudousxd/nestjs-telescope';
import { type CacheEventInput, type CustomCacheSource } from '@dudousxd/nestjs-telescope-cache';

export const CACHE_EMIT_HOLDER = Symbol('CACHE_EMIT_HOLDER');

export class CacheEmitHolder {
  private emit: ((event: CacheEventInput) => void) | null = null;

  /** The custom cache source handed to the CacheWatcher; captures `emit`. */
  source(): CustomCacheSource {
    return {
      instrument: (emit: (event: CacheEventInput) => void, _ctx: WatcherContext): void => {
        this.emit = emit;
      },
    };
  }

  /** Fire `count` cache hit/miss events into the active request batch. */
  fire(requestIndex: number, count: number): void {
    if (this.emit === null) return;
    for (let index = 0; index < count; index += 1) {
      const hit = (requestIndex + index) % 3 !== 0;
      this.emit({ operation: 'get', key: `base:${requestIndex % 64}:fleet:${index}`, hit });
    }
  }
}
