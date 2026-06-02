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
    expect(entry.familyHash).toBe('GET api.example.com');
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
});
