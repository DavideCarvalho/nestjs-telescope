// packages/core/src/http/axios-source.ts
import type { WatcherContext } from '../nest/watcher.js';

/**
 * Structural (duck-typed) view of the axios surface the HTTP-client watcher
 * needs. We DELIBERATELY don't depend on axios: core ships with no peer
 * dependency on it, so a host that resolves `HttpService.axiosRef` (or holds a
 * bare axios instance) can hand it over and we match by shape, not by import.
 *
 * Only the public interceptor API is modeled — capture happens through
 * `interceptors.request.use` / `interceptors.response.use`, never by patching
 * axios internals. Each shape is the minimal, precise set of optional fields we
 * read; nothing is widened to `any`, so a structural mismatch surfaces at the
 * call site instead of silently passing.
 */

/** A request config as axios hands it to a request interceptor. Every field is
 *  optional because axios populates them progressively (e.g. a relative `url`
 *  with a shared `baseURL`, or a config with no `params`). We read these to
 *  reconstruct the outbound target; we never mutate the config. */
export interface AxiosRequestConfigLike {
  method?: string;
  url?: string;
  baseURL?: string;
  /** Query params; axios accepts many shapes, so we serialize conservatively
   *  (only plain objects) and otherwise skip them — see the watcher. */
  params?: unknown;
}

/** A fulfilled response as axios hands it to a response interceptor. We read the
 *  status for the captured entry and the `config` to recover timing + target. */
export interface AxiosResponseLike {
  status: number;
  config: AxiosRequestConfigLike;
}

/** A rejection axios passes to the response interceptor's `onRejected`. On a
 *  non-2xx HTTP response it carries `response.status`; on a transport failure
 *  (DNS/connect/timeout) there is no `response`, so status is absent — which we
 *  record as `null`. `config` may be present so we can still recover the target
 *  and timing for failed calls. */
export interface AxiosErrorLike {
  config?: AxiosRequestConfigLike;
  response?: { status: number };
}

/**
 * The minimal interceptor-registration surface of an axios instance. Both the
 * `axios` default export and an `axios.create()` instance expose exactly this;
 * `@nestjs/axios`'s `HttpService.axiosRef` IS such an instance.
 *
 * `request.use(onFulfilled)` runs before the request leaves; we stamp a start
 * time there. `response.use(onFulfilled, onRejected)` runs on the way back; we
 * compute duration and record on both branches. We ignore the handler ids axios
 * returns (used for ejecting) — we never eject.
 */
export interface AxiosInterceptorLike {
  interceptors: {
    request: {
      use(onFulfilled: (config: AxiosRequestConfigLike) => AxiosRequestConfigLike): number;
    };
    response: {
      use(
        onFulfilled: (response: AxiosResponseLike) => AxiosResponseLike,
        onRejected: (error: unknown) => unknown,
      ): number;
    };
  };
}

/**
 * Custom axios source — the lazy-resolution escape hatch, mirroring
 * {@link CustomCacheSource}. Instead of handing over an axios instance eagerly
 * (which a host often can't, because `HttpService` isn't constructed until the
 * Nest container is up), the host provides an `instrument` hook.
 *
 * `instrument` is called exactly once at `register()` with:
 * - `attach`: hand it the resolved axios instance and the watcher wires its
 *   interceptors. Safe to call zero or one time; calling it twice with the same
 *   instance is harmless (idempotent via the watcher's instrumented-instance
 *   set).
 * - `ctx`: the {@link WatcherContext}, so the host can resolve `HttpService`
 *   from `ctx.moduleRef` (`ctx.moduleRef.get(HttpService, { strict: false })`)
 *   and pass `httpService.axiosRef`.
 */
export interface CustomAxiosSource {
  instrument(attach: (instance: AxiosInterceptorLike) => void, ctx: WatcherContext): void;
}

/** Narrows the watcher option to a {@link CustomAxiosSource} (lazy path) vs a
 *  bare {@link AxiosInterceptorLike} (eager path) by the presence of
 *  `instrument`. */
export function isCustomAxiosSource(
  source: AxiosInterceptorLike | CustomAxiosSource,
): source is CustomAxiosSource {
  return 'instrument' in source && typeof source.instrument === 'function';
}
