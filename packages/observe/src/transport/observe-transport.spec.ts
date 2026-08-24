import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExporterLogger, FetchLike } from '../observe-options.js';
import type { WireTelemetryBatch } from '../wire/telemetry-wire.js';
import { ObserveTransport, type ObserveTransportOptions } from './observe-transport.js';

const ENDPOINT = 'https://observe-api.example.test';
const APP_KEY = 'key-abc';
const APP_SECRET = 'secret-xyz';

const BATCH: WireTelemetryBatch = {
  serviceId: 'checkout-api',
  serviceVersion: '1.4.2',
  snapshots: [
    {
      ct: '2026-08-24T10:00:00.000Z',
      ti: 'trace-1',
      d: 12,
      op: 'GET /orders',
      a: { m: 'GET', sc: 200, ou: '/orders' },
      t: [
        { n: 'OrdersController.find', o: 'auto', d: 11, so: 0, c: 'OrdersController', m: 'find' },
      ],
    },
  ],
  logs: [{ timestamp: 1_756_029_600_000, text: 'hello', level: 'log' }],
};

interface FakeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  headers?: unknown;
}

function response(status: number, body = '', headers?: unknown): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    headers,
  };
}

/**
 * A tight `setImmediate` loop runs in the check phase and can starve the poll
 * phase, where libuv delivers zlib's thread-pool completion — the gzip that
 * every send awaits. Yielding through a REAL timer (captured before the fake
 * ones are installed) forces a full loop turn instead.
 */
const realSetTimeout = globalThis.setTimeout;

function yieldToIo(): Promise<void> {
  return new Promise((resolve) => {
    realSetTimeout(resolve, 0);
  });
}

function flush(): Promise<void> {
  return (async () => {
    for (let i = 0; i < 5; i++) {
      await yieldToIo();
    }
  })();
}

/** Waits for the zlib thread-pool callback to land and the attempt to reach the fake fetch. */
async function waitForCalls(mock: { mock: { calls: unknown[] } }, count: number): Promise<void> {
  for (let i = 0; i < 100 && mock.mock.calls.length < count; i++) {
    await yieldToIo();
  }
  expect(mock.mock.calls.length).toBe(count);
}

/** Drives backoff and abort timers until `promise` settles, without waiting in real time. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  const tracked = promise.then((value) => {
    done = true;
    return value;
  });

  for (let i = 0; i < 40 && !done; i++) {
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
  }

  await flush();
  return tracked;
}

describe('ObserveTransport', () => {
  let now: number;
  let warnings: string[];
  let logger: ExporterLogger;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    now = 1_700_000_000_000;
    warnings = [];
    logger = { warn: (message) => warnings.push(message) };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function build(
    fetchImpl: (...args: any[]) => Promise<FakeResponse>,
    overrides: Partial<ObserveTransportOptions> = {},
  ) {
    const fetchMock = vi.fn(fetchImpl);
    const transport = new ObserveTransport({
      endpoint: ENDPOINT,
      appKey: APP_KEY,
      appSecret: APP_SECRET,
      maxRetries: 3,
      clock: () => now,
      logger,
      fetch: fetchMock as unknown as FetchLike,
      ...overrides,
    });
    return { transport, fetchMock };
  }

  it('POSTs the gzipped batch to the telemetry path with the credential headers', async () => {
    const { transport, fetchMock } = build(async () => response(200));

    await expect(settle(transport.send(BATCH))).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://observe-api.example.test/applications/telemetry');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
      'x-api-key': APP_KEY,
      'x-api-secret': APP_SECRET,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends a gzip stream that round-trips back to the same batch', async () => {
    const { transport, fetchMock } = build(async () => response(200));

    await settle(transport.send(BATCH));

    const body: Uint8Array = fetchMock.mock.calls[0]![1].body;
    expect(body).toBeInstanceOf(Uint8Array);
    expect([body[0], body[1]]).toEqual([0x1f, 0x8b]);
    expect(JSON.parse(gunzipSync(body).toString('utf8'))).toEqual(BATCH);
  });

  it('retries a 500 and reports success once the collector recovers', async () => {
    const statuses = [500, 503, 200];
    let call = 0;
    const { transport, fetchMock } = build(async () => response(statuses[call++]!));

    await expect(settle(transport.send(BATCH))).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(transport.counters).toMatchObject({
      sent: 1,
      failed: 0,
      retried: 2,
      droppedPermanent: 0,
      lastStatus: 200,
    });
  });

  it('gives up once the attempts are exhausted', async () => {
    const { transport, fetchMock } = build(async () => response(503));

    await expect(settle(transport.send(BATCH))).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(transport.counters).toMatchObject({
      sent: 0,
      failed: 1,
      retried: 2,
      droppedPermanent: 0,
      lastStatus: 503,
      lastErrorAt: now,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('503');
    expect(warnings[0]).toContain('/applications/telemetry');
  });

  it('waits out a Retry-After header instead of its own backoff', async () => {
    let call = 0;
    const { transport, fetchMock } = build(async () =>
      call++ === 0 ? response(429, '', { 'retry-after': '5' }) : response(200),
    );

    const sent = transport.send(BATCH);
    await waitForCalls(fetchMock, 1);

    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_100);
    await waitForCalls(fetchMock, 2);

    await expect(settle(sent)).resolves.toBe(true);
  });

  it('reads Retry-After through a Headers-like response too', async () => {
    let call = 0;
    const headers = { get: (name: string) => (name === 'retry-after' ? '2' : null) };
    const { transport, fetchMock } = build(async () =>
      call++ === 0 ? response(429, '', headers) : response(200),
    );

    const sent = transport.send(BATCH);
    await waitForCalls(fetchMock, 1);

    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_100);
    await waitForCalls(fetchMock, 2);
    await expect(settle(sent)).resolves.toBe(true);
  });

  it('never retries a 400, because the same body earns the same rejection', async () => {
    const { transport, fetchMock } = build(async () =>
      response(400, 'property snapshots.0.st should not exist'),
    );

    await expect(settle(transport.send(BATCH))).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(transport.counters).toMatchObject({
      sent: 0,
      failed: 1,
      retried: 0,
      droppedPermanent: 1,
      lastStatus: 400,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('400');
    expect(warnings[0]).toContain('/applications/telemetry');
    expect(warnings[0]).toContain('snapshots.0.st');
    expect(transport.disabled).toBe(false);
  });

  it('does not retry a 413 either', async () => {
    const { transport, fetchMock } = build(async () => response(413));

    await expect(settle(transport.send(BATCH))).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(transport.counters.droppedPermanent).toBe(1);
  });

  it('keeps the credentials out of every warning', async () => {
    const { transport } = build(async () => response(400, 'bad request'));

    await settle(transport.send(BATCH));

    for (const warning of warnings) {
      expect(warning).not.toContain(APP_KEY);
      expect(warning).not.toContain(APP_SECRET);
    }
  });

  it('trips the breaker on a 401, so later sends never reach fetch', async () => {
    const { transport, fetchMock } = build(async () => response(401, 'invalid credentials'));

    await expect(settle(transport.send(BATCH))).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(transport.disabled).toBe(true);

    fetchMock.mockClear();
    await expect(settle(transport.send(BATCH))).resolves.toBe(false);
    await expect(settle(transport.send(BATCH))).resolves.toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(transport.counters).toMatchObject({
      sent: 0,
      failed: 3,
      droppedPermanent: 3,
      lastStatus: 401,
    });
  });

  it('trips the breaker on a 403 as well', async () => {
    const { transport, fetchMock } = build(async () => response(403));

    await settle(transport.send(BATCH));
    expect(transport.disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('warns once when the breaker opens, then at most hourly with the running total', async () => {
    const { transport } = build(async () => response(401));

    await settle(transport.send(BATCH));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('401');

    for (let i = 0; i < 5; i++) {
      now += 600_000;
      await settle(transport.send(BATCH));
    }
    expect(warnings).toHaveLength(1);

    now += 600_000;
    await settle(transport.send(BATCH));
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain('6 batch(es)');

    now += 600_000;
    await settle(transport.send(BATCH));
    expect(warnings).toHaveLength(2);

    now += 3_600_000;
    await settle(transport.send(BATCH));
    expect(warnings).toHaveLength(3);
    expect(warnings[2]).toContain('2 batch(es)');
  });

  it('retries a rejected fetch and then gives up without throwing', async () => {
    const { transport, fetchMock } = build(async () => {
      throw new Error('ECONNRESET');
    });

    await expect(settle(transport.send(BATCH))).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(transport.counters).toMatchObject({ sent: 0, failed: 1, retried: 2, lastStatus: null });
    expect(transport.counters.lastErrorAt).toBe(now);
    expect(warnings[0]).toContain('ECONNRESET');
  });

  it('recovers when a rejected fetch is followed by a success', async () => {
    let call = 0;
    const { transport } = build(async () => {
      if (call++ === 0) throw new Error('socket hang up');
      return response(202);
    });

    await expect(settle(transport.send(BATCH))).resolves.toBe(true);
    expect(transport.counters).toMatchObject({ sent: 1, retried: 1, failed: 0 });
  });

  it('aborts an attempt that outlives the request timeout', async () => {
    const signals: AbortSignal[] = [];
    const { transport, fetchMock } = build(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise<FakeResponse>((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signals.push(signal);
          signal.addEventListener('abort', () => {
            const error = new Error('The operation was aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
      { maxRetries: 1 },
    );

    const sent = transport.send(BATCH);
    await waitForCalls(fetchMock, 1);
    expect(signals[0]!.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    await flush();

    await expect(settle(sent)).resolves.toBe(false);
    expect(signals[0]!.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(transport.counters).toMatchObject({ sent: 0, failed: 1, retried: 0 });
    expect(warnings[0]).toContain('AbortError');
  });

  it('resets the counters view it hands out', async () => {
    const { transport } = build(async () => response(200));

    const before = transport.counters;
    await settle(transport.send(BATCH));

    expect(before.sent).toBe(0);
    expect(transport.counters.sent).toBe(1);
  });
});
