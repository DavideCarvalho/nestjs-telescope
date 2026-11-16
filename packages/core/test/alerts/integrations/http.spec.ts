// packages/core/test/alerts/integrations/http.spec.ts
import { describe, expect, it } from 'vitest';
import { DeliveryError, deliver } from '../../../src/alerts/integrations/http.js';
import { fakeSleep, mockFetch } from './helpers.js';

const SECRET_URL = 'https://events.example/v2/enqueue?token=s3cr3t-token';

describe('deliver', () => {
  it('sends JSON with a content-type and returns the parsed body', async () => {
    const { fetch, calls } = mockFetch([{ status: 202, json: { id: 'abc' } }]);
    const result = await deliver({ url: 'https://x.example', body: { a: 1 } }, { fetch });
    expect(result).toEqual({ status: 202, json: { id: 'abc' } });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(calls[0]?.json).toEqual({ a: 1 });
  });

  it('retries 5xx and network errors with exponential backoff, then succeeds', async () => {
    const { fetch, calls } = mockFetch([
      { status: 503 },
      new TypeError('fetch failed'),
      { status: 200 },
    ]);
    const { sleep, delays } = fakeSleep();
    await deliver({ url: 'https://x.example', body: {} }, { fetch, sleep, backoffMs: 100 });
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([100, 200]);
  });

  it('honours Retry-After on a 429', async () => {
    const { fetch } = mockFetch([
      { status: 429, headers: { 'retry-after': '7' } },
      { status: 200 },
    ]);
    const { sleep, delays } = fakeSleep();
    await deliver({ url: 'https://x.example', body: {} }, { fetch, sleep });
    expect(delays).toEqual([7000]);
  });

  it('does not retry a 4xx config error', async () => {
    const { fetch, calls } = mockFetch([{ status: 400 }]);
    const { sleep } = fakeSleep();
    await expect(deliver({ url: 'https://x.example', body: {} }, { fetch, sleep })).rejects.toThrow(
      'HTTP 400',
    );
    expect(calls).toHaveLength(1);
  });

  it('gives up after `retries` and never puts the URL or secret in the error', async () => {
    const { fetch, calls } = mockFetch([new Error(`connect ECONNREFUSED ${SECRET_URL}`)]);
    const { sleep } = fakeSleep();
    const error = await deliver(
      { url: SECRET_URL, headers: { authorization: 'Bearer s3cr3t-token' }, body: {} },
      { fetch, sleep, retries: 3 },
    ).catch((e: unknown) => e);
    expect(calls).toHaveLength(4);
    expect(error).toBeInstanceOf(DeliveryError);
    expect(String((error as Error).message)).not.toContain('s3cr3t');
    expect(String((error as Error).message)).not.toContain('events.example');
  });

  it('times out a hung endpoint', async () => {
    const fetch = (_url: string, init: { signal: AbortSignal }) =>
      new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    await expect(
      deliver({ url: 'https://x.example', body: {} }, { fetch, timeoutMs: 10, retries: 0 }),
    ).rejects.toThrow('timed out after 10ms');
  });
});
