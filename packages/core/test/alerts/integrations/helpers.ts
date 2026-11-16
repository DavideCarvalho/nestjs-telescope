// packages/core/test/alerts/integrations/helpers.ts
import { vi } from 'vitest';
import type { AlertPayload } from '../../../src/alerts/alert-rule.js';
import type { HttpFetch } from '../../../src/alerts/integrations/http.js';

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  json: unknown;
}

/**
 * A mock `fetch` that records every request and answers from `responses` in
 * order (the last one repeats). A response is `{ status, json?, headers? }` or an
 * `Error` to throw. Never touches the network.
 */
export function mockFetch(
  responses: Array<{ status: number; json?: unknown; headers?: Record<string, string> } | Error> = [
    { status: 200 },
  ],
) {
  const calls: Call[] = [];
  let index = 0;
  const fetch = vi.fn<HttpFetch>(async (url, init) => {
    let json: unknown;
    try {
      json = init.body !== undefined ? JSON.parse(init.body) : undefined;
    } catch {
      json = undefined;
    }
    calls.push({ url, method: init.method, headers: init.headers, body: init.body, json });
    const response = responses[Math.min(index, responses.length - 1)];
    index++;
    if (response instanceof Error) throw response;
    return {
      ok: response!.status >= 200 && response!.status < 300,
      status: response!.status,
      headers: new Headers(response!.headers ?? {}),
      json: async () => response!.json ?? {},
    };
  });
  return { fetch, calls };
}

/** Sleep seam that records the requested delays and returns at once. */
export function fakeSleep() {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

export function metricAlert(status: 'firing' | 'resolved' = 'firing'): AlertPayload {
  return {
    rule: {
      type: 'metric-threshold' as const,
      metric: 'request-p99-ms',
      window: '5m',
      comparator: 'gte',
      threshold: 500,
    },
    value: status === 'firing' ? 812.5 : 120,
    threshold: 500,
    firedAt: '2026-11-15T12:00:00.000Z',
    instanceId: 'web-1',
    ...(status === 'resolved' ? { status } : {}),
    dashboardUrl: 'https://telescope.example/',
  };
}

export function exceptionAlert(): AlertPayload {
  return {
    rule: { type: 'new-exception', window: '1h' },
    value: 1,
    threshold: 1,
    firedAt: '2026-11-15T12:00:00.000Z',
    instanceId: 'web-1',
    dashboardUrl: 'https://telescope.example',
    exception: {
      familyHash: 'fam-A',
      class: 'TypeError',
      message: 'cannot read <x> & y',
      stack: 'TypeError: cannot read x\n  at a\n  at b',
      route: '/checkout',
      method: 'POST',
      statusCode: 500,
      userAgent: null,
      referer: null,
      componentStack: null,
      extra: null,
      client: false,
      clientIp: null,
      geo: null,
      durationMs: null,
      user: '42',
      occurrences: 3,
      isNew: false,
      entryId: 'ex-1',
      batchId: 'b-1',
    },
  };
}
