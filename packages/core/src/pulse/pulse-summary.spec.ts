// packages/core/src/pulse/pulse-summary.spec.ts
import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { summarizePulse } from './pulse-summary.js';

function entry(partial: Partial<Entry> & { type: string }): Entry {
  return {
    id: `e-${Math.random()}`,
    batchId: partial.batchId ?? 'b',
    type: partial.type,
    familyHash: partial.familyHash ?? null,
    content: partial.content ?? {},
    tags: [],
    sequence: 0,
    durationMs: partial.durationMs ?? null,
    origin: 'http',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt: partial.createdAt ?? new Date('2026-06-02T12:00:00Z'),
  };
}

const start = new Date('2026-06-02T11:00:00Z');
const end = new Date('2026-06-02T12:00:00Z');
const opts = { topN: 5, nPlusOneThreshold: 5, slowRouteMinCount: 1 };

describe('summarizePulse', () => {
  it('counts entries per type', () => {
    const summary = summarizePulse(
      [entry({ type: 'request' }), entry({ type: 'query' }), entry({ type: 'query' })],
      start,
      end,
      opts,
    );
    expect(summary.counts).toEqual({ request: 1, query: 2 });
  });

  it('ranks slowest entries by duration with a type-aware label', () => {
    const summary = summarizePulse(
      [
        entry({ type: 'request', durationMs: 50, content: { method: 'GET', uri: '/a' } }),
        entry({ type: 'query', durationMs: 300, content: { sql: 'select 1' } }),
        entry({ type: 'job', durationMs: 100, content: { queue: 'mail', name: 'send' } }),
        entry({ type: 'request', durationMs: null, content: { uri: '/no-duration' } }),
      ],
      start,
      end,
      opts,
    );
    expect(summary.slowest.map((s) => s.durationMs)).toEqual([300, 100, 50]);
    expect(summary.slowest[0]!.label).toBe('select 1');
    expect(summary.slowest[1]!.label).toBe('mail:send');
    expect(summary.slowest[2]!.label).toBe('GET /a');
  });

  it('groups exceptions by familyHash with counts and last-seen', () => {
    const summary = summarizePulse(
      [
        entry({
          type: 'exception',
          familyHash: 'Error:boom',
          content: { class: 'Error', message: 'boom' },
          createdAt: new Date('2026-06-02T11:10:00Z'),
        }),
        entry({
          type: 'exception',
          familyHash: 'Error:boom',
          content: { class: 'Error', message: 'boom' },
          createdAt: new Date('2026-06-02T11:50:00Z'),
        }),
        entry({
          type: 'exception',
          familyHash: 'TypeError:nope',
          content: { class: 'TypeError', message: 'nope' },
          createdAt: new Date('2026-06-02T11:20:00Z'),
        }),
      ],
      start,
      end,
      opts,
    );
    expect(summary.topExceptions[0]).toMatchObject({
      familyHash: 'Error:boom',
      class: 'Error',
      message: 'boom',
      count: 2,
      lastSeen: '2026-06-02T11:50:00.000Z',
    });
    expect(summary.topExceptions[1]!.count).toBe(1);
  });

  it('aggregates N+1 by family across requests into one hotspot', () => {
    const batches = ['req-1', 'req-2', 'req-3'].flatMap((batchId) =>
      Array.from({ length: 6 }, () =>
        entry({
          type: 'query',
          batchId,
          familyHash: 'q:findUser',
          content: { sql: 'select * from users where id = ?' },
        }),
      ),
    );
    // A different batch where the same family only runs twice (below threshold).
    const below = Array.from({ length: 2 }, () =>
      entry({
        type: 'query',
        batchId: 'req-4',
        familyHash: 'q:findUser',
        content: { sql: 'select * from users where id = ?' },
      }),
    );
    const summary = summarizePulse([...batches, ...below], start, end, opts);
    expect(summary.nPlusOne).toHaveLength(1);
    expect(summary.nPlusOne[0]).toMatchObject({
      familyHash: 'q:findUser',
      sql: 'select * from users where id = ?',
      perRequest: 6,
      requests: 3,
      total: 18,
    });
    expect(['req-1', 'req-2', 'req-3']).toContain(summary.nPlusOne[0]!.sampleBatchId);
  });

  it('tracks the worst batch as the sample for a hotspot', () => {
    const small = Array.from({ length: 5 }, () =>
      entry({ type: 'query', batchId: 'small', familyHash: 'q:x', content: { sql: 'x' } }),
    );
    const big = Array.from({ length: 9 }, () =>
      entry({ type: 'query', batchId: 'big', familyHash: 'q:x', content: { sql: 'x' } }),
    );
    const summary = summarizePulse([...small, ...big], start, end, opts);
    expect(summary.nPlusOne).toHaveLength(1);
    expect(summary.nPlusOne[0]).toMatchObject({
      familyHash: 'q:x',
      perRequest: 9,
      requests: 2,
      total: 14,
      sampleBatchId: 'big',
    });
  });

  it('respects topN for slowest', () => {
    const slow = Array.from({ length: 8 }, (_, i) =>
      entry({ type: 'query', durationMs: i + 1, content: { sql: `q${i}` } }),
    );
    const summary = summarizePulse(slow, start, end, {
      topN: 3,
      nPlusOneThreshold: 5,
      slowRouteMinCount: 1,
    });
    expect(summary.slowest).toHaveLength(3);
    expect(summary.slowest.map((s) => s.durationMs)).toEqual([8, 7, 6]);
  });

  it('does not throw on malformed content and falls back to the entry type for labels', () => {
    const summary = summarizePulse(
      [
        entry({ type: 'query', durationMs: 1, content: null }),
        entry({ type: 'request', durationMs: 2, content: 42 }),
      ],
      start,
      end,
      opts,
    );
    const labels = summary.slowest.map((s) => s.label);
    expect(labels).toContain('query');
    expect(labels).toContain('request');
  });

  it('skips exceptions with a null familyHash', () => {
    const summary = summarizePulse(
      [entry({ type: 'exception', familyHash: null, content: { class: 'Error', message: 'x' } })],
      start,
      end,
      opts,
    );
    expect(summary.topExceptions).toEqual([]);
  });

  it('orders distinct N+1 families by total repetitions desc', () => {
    const familyA = Array.from({ length: 5 }, () =>
      entry({ type: 'query', batchId: 'A', familyHash: 'q:a', content: { sql: 'a' } }),
    );
    const familyB = Array.from({ length: 7 }, () =>
      entry({ type: 'query', batchId: 'B', familyHash: 'q:b', content: { sql: 'b' } }),
    );
    const summary = summarizePulse([...familyA, ...familyB], start, end, opts);
    expect(summary.nPlusOne.map((n) => n.familyHash)).toEqual(['q:b', 'q:a']); // total 7 before 5
  });

  it('applies topN to exceptions and truncates long labels', () => {
    const exceptions = Array.from({ length: 8 }, (_, i) =>
      entry({ type: 'exception', familyHash: `E${i}:m`, content: { class: 'E', message: 'm' } }),
    );
    const byTopN = summarizePulse(exceptions, start, end, {
      topN: 3,
      nPlusOneThreshold: 5,
      slowRouteMinCount: 1,
    });
    expect(byTopN.topExceptions).toHaveLength(3);

    const longSql = 'x'.repeat(1000);
    const truncated = summarizePulse(
      [entry({ type: 'query', durationMs: 1, content: { sql: longSql } })],
      start,
      end,
      opts,
    );
    expect(truncated.slowest[0]!.label.endsWith('…')).toBe(true);
    expect(truncated.slowest[0]!.label.length).toBeLessThanOrEqual(501); // 500 chars + ellipsis
  });

  it('sets window fields and handles empty input', () => {
    const summary = summarizePulse([], start, end, opts);
    expect(summary.windowStart).toBe('2026-06-02T11:00:00.000Z');
    expect(summary.windowMs).toBe(3_600_000);
    expect(summary.counts).toEqual({});
    expect(summary.slowest).toEqual([]);
    expect(summary.topExceptions).toEqual([]);
    expect(summary.nPlusOne).toEqual([]);
    expect(summary.slowRoutes).toEqual([]);
  });

  it('ranks slow-route hotspots by p99 with per-route count and percentiles', () => {
    // Two routes: "GET /api/slow/:id" is consistently slower than "GET /api/fast".
    const slowRoute = [10, 20, 30, 200].map((durationMs) =>
      entry({ type: 'request', familyHash: 'GET /api/slow/:id', durationMs }),
    );
    const fastRoute = [5, 6, 7, 8].map((durationMs) =>
      entry({ type: 'request', familyHash: 'GET /api/fast', durationMs }),
    );
    const summary = summarizePulse([...slowRoute, ...fastRoute], start, end, opts);

    expect(summary.slowRoutes).toHaveLength(2);
    expect(summary.slowRoutes[0]).toMatchObject({
      route: 'GET /api/slow/:id',
      count: 4,
      p99: 200,
      p50: 20,
    });
    expect(summary.slowRoutes[1]!.route).toBe('GET /api/fast');
    expect(summary.slowRoutes[1]!.p99).toBe(8);
  });

  it('ignores request entries with a null familyHash for slow routes', () => {
    const summary = summarizePulse(
      [
        entry({ type: 'request', familyHash: null, durationMs: 999 }),
        entry({ type: 'request', familyHash: 'GET /api/ok', durationMs: 10 }),
      ],
      start,
      end,
      opts,
    );
    expect(summary.slowRoutes.map((route) => route.route)).toEqual(['GET /api/ok']);
  });

  it('drops routes below slowRouteMinCount', () => {
    const summary = summarizePulse(
      [
        entry({ type: 'request', familyHash: 'GET /api/one', durationMs: 500 }),
        entry({ type: 'request', familyHash: 'GET /api/two', durationMs: 10 }),
        entry({ type: 'request', familyHash: 'GET /api/two', durationMs: 20 }),
      ],
      start,
      end,
      { topN: 5, nPlusOneThreshold: 5, slowRouteMinCount: 2 },
    );
    expect(summary.slowRoutes.map((route) => route.route)).toEqual(['GET /api/two']);
  });

  it('aggregates slow outgoing http_client calls by family, ranked by p99', () => {
    const summary = summarizePulse(
      [
        entry({
          type: 'http_client',
          familyHash: 'GET api.stripe.com/v1/charges/:id',
          durationMs: 900,
        }),
        entry({
          type: 'http_client',
          familyHash: 'GET api.stripe.com/v1/charges/:id',
          durationMs: 700,
        }),
        entry({ type: 'http_client', familyHash: 'GET fast.example.com/ping', durationMs: 5 }),
        // requests must not leak into the outgoing bucket
        entry({ type: 'request', familyHash: 'GET /api/x', durationMs: 9999 }),
      ],
      start,
      end,
      opts,
    );
    expect(summary.slowOutgoing.map((hotspot) => hotspot.route)).toEqual([
      'GET api.stripe.com/v1/charges/:id',
      'GET fast.example.com/ping',
    ]);
    const stripe = summary.slowOutgoing[0]!;
    expect(stripe.count).toBe(2);
    expect(stripe.p99).toBe(900);
  });

  it('omits http_client entries without a familyHash from slowOutgoing', () => {
    const summary = summarizePulse(
      [entry({ type: 'http_client', familyHash: null, durationMs: 800 })],
      start,
      end,
      opts,
    );
    expect(summary.slowOutgoing).toEqual([]);
  });
});
