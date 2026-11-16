import { axiosHeaders, axiosRequestUrl } from '../http/axios-instances.js';
// packages/core/src/tracing/axios.ts
//
// Outgoing propagation through axios, the way most Nest apps call out (`@nestjs/axios`'s
// `HttpService`): a request interceptor adds `traceparent` / `tracestate` with the same rules as
// `fetch` (targets only, never twice, never on telescope's own work, never beside an
// OpenTelemetry propagator). The header is set on the request config, so the `nodeHttp` hook
// (axios's node adapter goes through `http.request`) and the `fetch` hook (its fetch adapter) see
// it already there and add nothing.
import { type AxiosInterceptorLike, type AxiosRequestConfigLike } from '../http/axios-source.js';
import type { ResolvedPropagation } from './config.js';
import { originOf } from './config.js';
import { headersFor } from './outbound.js';

/** Instances already carrying the interceptor: whether it acts, and with which settings. */
const ATTACHED = new WeakMap<
  AxiosInterceptorLike,
  { active: boolean; config: ResolvedPropagation }
>();

/** Add the trace headers to one axios request config. Exported for tests. */
export function injectIntoAxiosConfig(
  config: ResolvedPropagation,
  request: AxiosRequestConfigLike & { headers?: unknown },
): void {
  const url = axiosRequestUrl(request);
  if (url === null) return;
  const headers = axiosHeaders(request);
  if (headers.has('traceparent')) return;
  const trace = headersFor(config, originOf(url.href));
  if (trace === null) return;
  headers.set('traceparent', trace.traceparent);
  if (trace.tracestate !== undefined) headers.set('tracestate', trace.tracestate);
}

/**
 * Add the propagation interceptor to `instance`. An instance is intercepted once: attaching it
 * again (another app in the process, a restart in tests) takes over that interceptor with the new
 * settings. Returns the function that turns it off (axios cannot remove an interceptor without its
 * id, so it becomes a no-op).
 */
export function attachTracingToAxios(
  instance: AxiosInterceptorLike,
  config: ResolvedPropagation,
): () => void {
  let state = ATTACHED.get(instance);
  if (state === undefined) {
    const created = { active: true, config };
    state = created;
    ATTACHED.set(instance, created);
    instance.interceptors.request.use((request) => {
      if (!created.active) return request;
      try {
        injectIntoAxiosConfig(created.config, request);
      } catch {
        // Propagation never breaks the call.
      }
      return request;
    });
  } else {
    state.active = true;
    state.config = config;
  }
  const owned = state;
  return () => {
    if (owned.config === config) owned.active = false;
  };
}
