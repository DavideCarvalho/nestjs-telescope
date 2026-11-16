// packages/core/src/http/axios-instances.ts
//
// The axios instances an app's outgoing HTTP goes through in Nest: every `HttpService` from
// `@nestjs/axios` (the default `HttpModule` and each `HttpModule.register(...)` has its own), plus
// any instance the host hands over. Found structurally: `@nestjs/axios` is never a dependency.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { ModuleRef } from '@nestjs/core';
import { DiscoveryService } from '@nestjs/core';
import type { WatcherContext } from '../nest/watcher.js';
import {
  type AxiosInterceptorLike,
  type CustomAxiosSource,
  isCustomAxiosSource,
} from './axios-source.js';

/** An axios instance, or a {@link CustomAxiosSource} that resolves it lazily. */
export type AxiosSourceOption = AxiosInterceptorLike | CustomAxiosSource;

/** Whether `value` has axios's public interceptor API. */
export function isAxiosInstanceLike(value: unknown): value is AxiosInterceptorLike {
  const interceptors = (value as { interceptors?: Record<string, { use?: unknown }> } | null)
    ?.interceptors;
  return (
    typeof interceptors?.request?.use === 'function' &&
    typeof interceptors?.response?.use === 'function'
  );
}

/** `@nestjs/axios`'s `HttpService` class from the app's own install, or `undefined`. */
function httpServiceClass(): (abstract new (...args: never[]) => unknown) | undefined {
  try {
    const loaded = createRequire(join(process.cwd(), 'package.json'))('@nestjs/axios') as {
      HttpService?: abstract new (...args: never[]) => unknown;
    };
    return typeof loaded.HttpService === 'function' ? loaded.HttpService : undefined;
  } catch {
    return undefined;
  }
}

/** The axios instance of an `HttpService`-shaped provider (`axiosRef`), or `undefined`. */
function axiosRefOf(instance: unknown, httpService: unknown): AxiosInterceptorLike | undefined {
  if (instance === null || typeof instance !== 'object') return undefined;
  const isHttpService =
    (typeof httpService === 'function' && instance instanceof (httpService as new () => unknown)) ||
    (instance as { constructor?: { name?: string } }).constructor?.name === 'HttpService';
  if (!isHttpService) return undefined;
  const ref = (instance as { axiosRef?: unknown }).axiosRef;
  return isAxiosInstanceLike(ref) ? ref : undefined;
}

/**
 * The axios instance of every `HttpService` in the app: each module that imports `HttpModule`
 * (or `HttpModule.register(...)`) gets its own. Request-scoped providers are not instantiated at
 * boot and are not found; hand those over through the `axios` option.
 */
export function findHttpServiceAxios(moduleRef: ModuleRef): AxiosInterceptorLike[] {
  const found = new Set<AxiosInterceptorLike>();
  const httpService = httpServiceClass();
  try {
    const discovery = moduleRef.get(DiscoveryService, { strict: false });
    for (const wrapper of discovery.getProviders()) {
      const ref = axiosRefOf(wrapper.instance, httpService);
      if (ref !== undefined) found.add(ref);
    }
  } catch {
    // No DiscoveryService: fall back to the one ModuleRef finds.
  }
  if (httpService !== undefined) {
    try {
      const ref = axiosRefOf(moduleRef.get(httpService, { strict: false }), httpService);
      if (ref !== undefined) found.add(ref);
    } catch {
      // No HttpService in the app.
    }
  }
  return [...found];
}

/**
 * Every axios instance to instrument: the app's `HttpService`s (unless `sources` is `false`) and
 * the instances in `sources` (a {@link CustomAxiosSource} is handed `attach` and `ctx`). `attach`
 * is called once per distinct instance.
 */
export function forEachAxiosInstance(
  sources: AxiosSourceOption | AxiosSourceOption[] | false | undefined,
  moduleRef: ModuleRef,
  ctx: () => WatcherContext,
  attach: (instance: AxiosInterceptorLike) => void,
): void {
  const seen = new Set<AxiosInterceptorLike>();
  const once = (instance: AxiosInterceptorLike) => {
    if (!isAxiosInstanceLike(instance) || seen.has(instance)) return;
    seen.add(instance);
    attach(instance);
  };
  if (sources === false) return;
  for (const instance of findHttpServiceAxios(moduleRef)) once(instance);
  const list = sources === undefined ? [] : Array.isArray(sources) ? sources : [sources];
  for (const source of list) {
    if (isCustomAxiosSource(source)) source.instrument(once, ctx());
    else once(source);
  }
}

/** The absolute URL an axios request config targets (`baseURL` joined to `url`), or `null`. */
export function axiosRequestUrl(config: { url?: string; baseURL?: string }): URL | null {
  const url = config.url ?? '';
  try {
    if (/^[a-z][a-z\d+\-.]*:\/\//i.test(url)) return new URL(url);
    if (config.baseURL === undefined || config.baseURL === '') return null;
    const base = config.baseURL.replace(/\/+$/, '');
    return new URL(url === '' ? base : `${base}/${url.replace(/^\/+/, '')}`);
  } catch {
    return null;
  }
}

/** Read and write a header on an axios config's `headers` (an `AxiosHeaders` or a plain object). */
export function axiosHeaders(config: { headers?: unknown }): {
  has(name: string): boolean;
  set(name: string, value: string): void;
} {
  if (config.headers === undefined || config.headers === null) config.headers = {};
  const headers = config.headers as Record<string, unknown> & {
    has?: (name: string) => boolean;
    set?: (name: string, value: string) => unknown;
  };
  return {
    has: (name) =>
      typeof headers.has === 'function'
        ? headers.has(name)
        : Object.keys(headers).some((key) => key.toLowerCase() === name && headers[key] != null),
    set: (name, value) => {
      if (typeof headers.set === 'function') headers.set(name, value);
      else headers[name] = value;
    },
  };
}
