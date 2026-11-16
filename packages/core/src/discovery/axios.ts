// packages/core/src/discovery/axios.ts
//
// Service discovery through axios, the way most Nest apps call out (`@nestjs/axios`'s
// `HttpService`): a request interceptor rewrites `http://billing/…` with the same rules as `fetch`
// (single-label app names only; `strict`, `failFast` and `passthrough` alike; telescope's own
// work untouched). A `DiscoveryError` rejects the call. The request then runs marked as resolved,
// so the `fetch` and `nodeHttp` rewrites that axios's adapters go through leave it alone.
import { axiosRequestUrl } from '../http/axios-instances.js';
import type { AxiosInterceptorLike, AxiosRequestConfigLike } from '../http/axios-source.js';
import { resolveAxiosAdapter } from '../http/http-client.watcher.js';
import { isTelescopeWork } from '../otel/telescope-runtime.js';
import type { ServiceDirectory } from './directory.js';
import { runResolvedByDiscovery } from './handled.js';
import { type RewriteOptions, rewriteTarget } from './rewrite.js';

interface Attached {
  active: boolean;
  directory: ServiceDirectory;
  options: RewriteOptions;
}

const ATTACHED = new WeakMap<AxiosInterceptorLike, Attached>();
const RESOLVING_ADAPTER = Symbol.for('@dudousxd/nestjs-telescope:discoveryAdapter');

/**
 * Rewrite one axios request config in place. `true` when it named an app. Throws
 * `DiscoveryError` like the `fetch` rewrite. Exported for tests.
 */
export function rewriteAxiosConfig(
  directory: ServiceDirectory,
  options: RewriteOptions,
  request: AxiosRequestConfigLike,
): boolean {
  if (isTelescopeWork()) return false;
  const url = axiosRequestUrl(request);
  if (url === null) return false;
  const target = rewriteTarget(directory, options, url);
  if (target === null) return false;
  request.url = `${target.origin}${target.basePath}${url.pathname}${url.search}${url.hash}`;
  // The URL is absolute now; a baseURL would be joined to it with `allowAbsoluteUrls: false`.
  Reflect.deleteProperty(request, 'baseURL');
  return true;
}

/** Run the request's adapter marked as resolved, so the inner rewrites leave it alone. */
function markResolved(instance: AxiosInterceptorLike, request: AxiosRequestConfigLike): void {
  const current = request.adapter as { [RESOLVING_ADAPTER]?: true } | undefined;
  if (current?.[RESOLVING_ADAPTER]) return;
  const original = resolveAxiosAdapter(instance, request);
  if (original === undefined) return;
  const resolving = (config: unknown) => runResolvedByDiscovery(() => original(config));
  (resolving as { [RESOLVING_ADAPTER]?: true })[RESOLVING_ADAPTER] = true;
  request.adapter = resolving;
}

/**
 * Add the discovery interceptor to `instance`. An instance is intercepted once: attaching it again
 * takes the interceptor over with the new directory. Returns the function that turns it off.
 */
export function attachDiscoveryToAxios(
  instance: AxiosInterceptorLike,
  directory: ServiceDirectory,
  options: RewriteOptions,
): () => void {
  let state = ATTACHED.get(instance);
  if (state === undefined) {
    const created: Attached = { active: true, directory, options };
    state = created;
    ATTACHED.set(instance, created);
    instance.interceptors.request.use((request) => {
      if (!created.active) return request;
      // A DiscoveryError (strict, failFast) rejects the call, as it does for fetch.
      if (rewriteAxiosConfig(created.directory, created.options, request)) {
        try {
          markResolved(instance, request);
        } catch {
          // Unmarked: the inner rewrites see a real origin and pass it through anyway.
        }
      }
      return request;
    });
  } else {
    state.active = true;
    state.directory = directory;
    state.options = options;
  }
  const owned = state;
  return () => {
    if (owned.directory === directory) owned.active = false;
  };
}
