// packages/core/src/http/http-client.watcher.spec.ts
import 'reflect-metadata';
import {
  type BatchHandle,
  type BatchOrigin,
  type RecordInput,
  type WatcherContext,
  resolveConfig,
} from '@dudousxd/nestjs-telescope';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AxiosInterceptorLike,
  AxiosRequestConfigLike,
  AxiosResponseLike,
} from './axios-source.js';
import { HttpClientWatcher } from './http-client.watcher.js';

interface Harness {
  ctx: WatcherContext;
  recorded: RecordInput[];
}

function makeHarness(): Harness {
  const recorded: RecordInput[] = [];
  const ctx: WatcherContext = {
    record: (input) => recorded.push(input),
    runInBatch: <T>(_origin: BatchOrigin, fn: () => Promise<T>): Promise<T> => fn(),
    beginBatch: (): BatchHandle => ({ id: 'b', end: () => {} }),
    config: resolveConfig({}),
    moduleRef: { get: () => undefined } as unknown as WatcherContext['moduleRef'],
  };
  return { ctx, recorded };
}

/** Hand-rolled fake axios instance: it stores the interceptors registered via
 *  the public API and a `request(config)` that runs them in axios's order
 *  (request interceptors first, then the real "send", then response
 *  interceptors). The fake `send` either resolves a response or rejects with an
 *  axios-shaped error, mirroring how a real axios instance threads the SAME
 *  config object from request interceptor to response/error interceptor. */
interface FakeAxios extends AxiosInterceptorLike {
  request(config: AxiosRequestConfigLike): Promise<AxiosResponseLike>;
}

type SendResult =
  | { kind: 'ok'; status: number }
  | { kind: 'http-error'; status: number }
  | { kind: 'network-error' };

function makeFakeAxios(send: (config: AxiosRequestConfigLike) => SendResult): FakeAxios {
  const requestHandlers: Array<(config: AxiosRequestConfigLike) => AxiosRequestConfigLike> = [];
  const responseHandlers: Array<{
    onFulfilled: (response: AxiosResponseLike) => AxiosResponseLike;
    onRejected: (error: unknown) => unknown;
  }> = [];

  return {
    interceptors: {
      request: {
        use(onFulfilled) {
          requestHandlers.push(onFulfilled);
          return requestHandlers.length;
        },
      },
      response: {
        use(onFulfilled, onRejected) {
          responseHandlers.push({ onFulfilled, onRejected });
          return responseHandlers.length;
        },
      },
    },
    async request(config) {
      let cfg = config;
      for (const handler of requestHandlers) cfg = handler(cfg);

      const result = send(cfg);
      if (result.kind === 'ok') {
        let response: AxiosResponseLike = { status: result.status, config: cfg };
        for (const { onFulfilled } of responseHandlers) response = onFulfilled(response);
        return response;
      }

      const error =
        result.kind === 'http-error'
          ? { config: cfg, response: { status: result.status } }
          : { config: cfg };
      let rejection: unknown = error;
      for (const { onRejected } of responseHandlers) {
        try {
          rejection = await onRejected(rejection);
        } catch (thrown) {
          rejection = thrown;
        }
      }
      return Promise.reject(rejection);
    },
  };
}

describe('HttpClientWatcher', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('has type "http_client"', () => {
    expect(new HttpClientWatcher().type).toBe('http_client');
  });

  it('records a successful outbound request with method/url/host/status/duration', async () => {
    const fakeResponse = { status: 200 } as Response;
    globalThis.fetch = vi.fn(async () => fakeResponse) as typeof globalThis.fetch;
    const { ctx, recorded } = makeHarness();
    new HttpClientWatcher().register(ctx);

    const result = await globalThis.fetch('https://api.example.com/users?page=1');

    expect(result).toBe(fakeResponse);
    expect(recorded).toHaveLength(1);
    const entry = recorded[0]!;
    expect(entry.type).toBe('http_client');
    expect(entry.content).toMatchObject({
      method: 'GET',
      url: 'https://api.example.com/users?page=1',
      host: 'api.example.com',
      statusCode: 200,
    });
    // familyHash keeps the host AND normalizes the path so the same endpoint
    // groups regardless of ids — drives the pulse slow-outgoing hotspots.
    expect(entry.familyHash).toBe('GET api.example.com/users');
  });

  it('normalizes id-like path segments in the familyHash', async () => {
    globalThis.fetch = vi.fn(async () => ({ status: 200 }) as Response) as typeof globalThis.fetch;
    const { ctx, recorded } = makeHarness();
    new HttpClientWatcher().register(ctx);

    await globalThis.fetch('https://api.stripe.com/v1/charges/123456');

    expect(recorded[0]!.familyHash).toBe('GET api.stripe.com/v1/charges/:id');
  });

  it('uses the method from init and tags 5xx + slow', async () => {
    let t = 0;
    const clock = {
      now: () => {
        const v = t;
        t += 1500;
        return v;
      },
    };
    globalThis.fetch = vi.fn(async () => ({ status: 503 }) as Response) as typeof globalThis.fetch;
    const { ctx, recorded } = makeHarness();
    new HttpClientWatcher({ slowMs: 1000, clock }).register(ctx);

    await globalThis.fetch('https://api.example.com/x', { method: 'post' });

    const entry = recorded[0]!;
    expect((entry.content as { method: string }).method).toBe('POST');
    expect((entry.content as { statusCode: number }).statusCode).toBe(503);
    expect(entry.durationMs).toBe(1500);
    expect(entry.tags).toContain('failed');
    expect(entry.tags).toContain('slow');
    expect(entry.tags).toContain('host:api.example.com');
  });

  it('records a network failure (statusCode null, failed) and re-throws', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof globalThis.fetch;
    const { ctx, recorded } = makeHarness();
    new HttpClientWatcher().register(ctx);

    await expect(globalThis.fetch('https://down.example.com/')).rejects.toThrow('ECONNREFUSED');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.content).toMatchObject({ statusCode: null });
    expect(recorded[0]!.tags).toContain('failed');
  });

  it('patches fetch only once across multiple registrations', async () => {
    const inner = vi.fn(async () => ({ status: 200 }) as Response);
    globalThis.fetch = inner as typeof globalThis.fetch;
    const { ctx, recorded } = makeHarness();
    new HttpClientWatcher().register(ctx);
    new HttpClientWatcher().register(ctx);

    await globalThis.fetch('https://api.example.com/x');
    expect(inner).toHaveBeenCalledTimes(1);
    expect(recorded).toHaveLength(1);
  });

  it('extracts method/url from a Request object', async () => {
    globalThis.fetch = vi.fn(async () => ({ status: 200 }) as Response) as typeof globalThis.fetch;
    const { ctx, recorded } = makeHarness();
    new HttpClientWatcher().register(ctx);

    await globalThis.fetch(new Request('https://api.example.com/r', { method: 'DELETE' }));
    expect(recorded[0]!.content).toMatchObject({ method: 'DELETE', host: 'api.example.com' });
  });

  it('strips credentials and redacts sensitive query params from the captured url', async () => {
    globalThis.fetch = vi.fn(async () => ({ status: 200 }) as Response) as typeof globalThis.fetch;
    const { ctx, recorded } = makeHarness();
    new HttpClientWatcher().register(ctx);

    await globalThis.fetch('https://user:pass@api.example.com/x?api_key=supersecret&page=2');

    const url = (recorded[0]!.content as { url: string }).url;
    expect(url).not.toContain('supersecret');
    expect(url).not.toContain('user:pass');
    expect(url.toLowerCase()).toContain('redacted');
    expect(url).toContain('page=2'); // non-sensitive param preserved
    expect((recorded[0]!.content as { host: string }).host).toBe('api.example.com');
  });

  it('records a relative/invalid URL with host null', async () => {
    globalThis.fetch = vi.fn(async () => ({ status: 200 }) as Response) as typeof globalThis.fetch;
    const { ctx, recorded } = makeHarness();
    new HttpClientWatcher().register(ctx);

    await globalThis.fetch('/api/relative');
    expect(recorded).toHaveLength(1);
    expect((recorded[0]!.content as { host: string | null }).host).toBeNull();
  });

  it('does not tag a 4xx response as failed', async () => {
    globalThis.fetch = vi.fn(async () => ({ status: 404 }) as Response) as typeof globalThis.fetch;
    const { ctx, recorded } = makeHarness();
    new HttpClientWatcher().register(ctx);

    await globalThis.fetch('https://api.example.com/missing');
    expect(recorded[0]!.tags ?? []).not.toContain('failed');
  });

  it('never throws into the host when recording fails', async () => {
    globalThis.fetch = vi.fn(async () => ({ status: 200 }) as Response) as typeof globalThis.fetch;
    const ctx = {
      record: () => {
        throw new Error('recorder boom');
      },
      runInBatch: <T>(_o: BatchOrigin, fn: () => Promise<T>) => fn(),
      beginBatch: (): BatchHandle => ({ id: 'b', end: () => {} }),
      config: resolveConfig({}),
      moduleRef: { get: () => undefined },
    } as unknown as WatcherContext;
    new HttpClientWatcher().register(ctx);

    await expect(globalThis.fetch('https://api.example.com/x')).resolves.toMatchObject({
      status: 200,
    });
  });

  describe('axios capture', () => {
    // Keep fetch a no-op so registering the watcher doesn't disturb the global,
    // and these tests exercise only the axios path.
    function registerWithAxios(
      axios: AxiosInterceptorLike,
      options: { slowMs?: number; clock?: { now(): number } } = {},
    ): Harness {
      globalThis.fetch = vi.fn(
        async () => ({ status: 200 }) as Response,
      ) as typeof globalThis.fetch;
      const harness = makeHarness();
      new HttpClientWatcher({ ...options, axios }).register(harness.ctx);
      return harness;
    }

    it('records a successful axios call with method/url/status/duration', async () => {
      let t = 0;
      const clock = {
        now: () => {
          const v = t;
          t += 25;
          return v;
        },
      };
      const axios = makeFakeAxios(() => ({ kind: 'ok', status: 201 }));
      const { recorded } = registerWithAxios(axios, { clock });

      const response = await axios.request({
        method: 'post',
        url: 'https://api.example.com/users',
      });

      expect(response.status).toBe(201);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.content).toMatchObject({
        method: 'POST',
        url: 'https://api.example.com/users',
        host: 'api.example.com',
        statusCode: 201,
        durationMs: 25,
      });
      expect(recorded[0]!.familyHash).toBe('POST api.example.com/users');
    });

    it('joins baseURL + relative url and serializes plain-object params', async () => {
      const axios = makeFakeAxios(() => ({ kind: 'ok', status: 200 }));
      const { recorded } = registerWithAxios(axios);

      await axios.request({
        baseURL: 'https://api.example.com/v1/',
        url: '/charges',
        params: { limit: 10 },
      });

      const url = (recorded[0]!.content as { url: string }).url;
      expect(url).toBe('https://api.example.com/v1/charges?limit=10');
    });

    it('redacts sensitive query params and strips credentials on the axios path', async () => {
      const axios = makeFakeAxios(() => ({ kind: 'ok', status: 200 }));
      const { recorded } = registerWithAxios(axios);

      await axios.request({
        url: 'https://user:pass@api.example.com/x',
        params: { api_key: 'supersecret', page: 2 },
      });

      const url = (recorded[0]!.content as { url: string }).url;
      expect(url).not.toContain('supersecret');
      expect(url).not.toContain('user:pass');
      expect(url.toLowerCase()).toContain('redacted');
      expect(url).toContain('page=2');
    });

    it('skips params that are not a plain object', async () => {
      const axios = makeFakeAxios(() => ({ kind: 'ok', status: 200 }));
      const { recorded } = registerWithAxios(axios);

      await axios.request({
        url: 'https://api.example.com/x',
        params: new URLSearchParams({ a: '1' }),
      });

      // URLSearchParams isn't a plain object → not serialized, url left as-is.
      expect((recorded[0]!.content as { url: string }).url).toBe('https://api.example.com/x');
    });

    it('records an HTTP-error response status and re-throws', async () => {
      const axios = makeFakeAxios(() => ({ kind: 'http-error', status: 500 }));
      const { recorded } = registerWithAxios(axios);

      await expect(axios.request({ url: 'https://api.example.com/boom' })).rejects.toMatchObject({
        response: { status: 500 },
      });

      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.content).toMatchObject({ statusCode: 500 });
      expect(recorded[0]!.tags).toContain('failed');
    });

    it('records a network error (no response) as statusCode null and re-throws', async () => {
      const axios = makeFakeAxios(() => ({ kind: 'network-error' }));
      const { recorded } = registerWithAxios(axios);

      await expect(axios.request({ url: 'https://down.example.com/' })).rejects.toBeDefined();

      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.content).toMatchObject({ statusCode: null });
      expect(recorded[0]!.tags).toContain('failed');
    });

    it('attaches interceptors only once per axios instance (WeakSet idempotency)', async () => {
      const axios = makeFakeAxios(() => ({ kind: 'ok', status: 200 }));
      globalThis.fetch = vi.fn(
        async () => ({ status: 200 }) as Response,
      ) as typeof globalThis.fetch;
      const { ctx, recorded } = makeHarness();

      // Same instance handed to two watchers — must not double-record.
      new HttpClientWatcher({ axios }).register(ctx);
      new HttpClientWatcher({ axios }).register(ctx);

      await axios.request({ url: 'https://api.example.com/x' });
      expect(recorded).toHaveLength(1);
    });

    it('custom source receives ctx and its attach wires capture', async () => {
      const axios = makeFakeAxios(() => ({ kind: 'ok', status: 200 }));
      globalThis.fetch = vi.fn(
        async () => ({ status: 200 }) as Response,
      ) as typeof globalThis.fetch;
      const { ctx, recorded } = makeHarness();

      let seenCtx: WatcherContext | undefined;
      new HttpClientWatcher({
        axios: {
          instrument(attach, instrumentCtx) {
            seenCtx = instrumentCtx;
            // A real host would resolve HttpService from ctx.moduleRef here and
            // pass httpService.axiosRef.
            attach(axios);
          },
        },
      }).register(ctx);

      expect(seenCtx).toBe(ctx);

      await axios.request({ url: 'https://api.example.com/from-source' });
      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.content).toMatchObject({
        url: 'https://api.example.com/from-source',
        statusCode: 200,
      });
    });
  });
});
