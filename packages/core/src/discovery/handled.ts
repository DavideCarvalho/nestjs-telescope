// packages/core/src/discovery/handled.ts
//
// A request whose app name the axios interceptor already resolved: the `fetch` and `node:http`
// rewrites (which axios's fetch and node adapters go through) leave it alone, so one request is
// never rewritten twice.
import { AsyncLocalStorage } from 'node:async_hooks';

const KEY = Symbol.for('@dudousxd/nestjs-telescope:discovery-handled');
const slot = globalThis as Record<symbol, unknown>;
const storage: AsyncLocalStorage<true> =
  (slot[KEY] as AsyncLocalStorage<true> | undefined) ?? new AsyncLocalStorage<true>();
slot[KEY] = storage;

/** Run `fn` as a request discovery already resolved. */
export function runResolvedByDiscovery<T>(fn: () => T): T {
  return storage.run(true, fn);
}

/** Whether the caller is inside {@link runResolvedByDiscovery}. */
export function isResolvedByDiscovery(): boolean {
  return storage.getStore() === true;
}
