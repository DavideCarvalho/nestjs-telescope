import { describe, expect, it } from 'vitest';
import type {
  CacheContent,
  ExceptionContent,
  QueryContent,
  RequestContent,
} from '../entry/content.js';
import { type Entry, EntryType } from '../entry/entry.js';
import { percentile, summarizeStats } from './stats.js';

const start = new Date('2026-06-02T11:00:00Z');
const end = new Date('2026-06-02T12:00:00Z'); // 60-minute window
const windowMs = end.getTime() - start.getTime();

function entry<TContent>(overrides: Partial<Entry<TContent>> & { type: string }): Entry<TContent> {
  return {
    id: `${overrides.type}-${Math.random()}`,
    batchId: 'b',
    type: overrides.type,
    familyHash: null,
    content: {} as TContent,
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt: new Date('2026-06-02T11:30:00Z'),
    ...overrides,
  };
}

function queryContent(sql: string): QueryContent {
  return { sql, bindings: [], connection: null, slow: false };
}

function requestContent(statusCode: number | null): RequestContent {
  return {
    method: 'GET',
    uri: '/x',
    headers: {},
    payload: null,
    response: null,
    statusCode,
    ip: null,
    memoryMb: null,
  };
}

function cacheContent(operation: 'get' | 'set', key: string, hit: boolean | null): CacheContent {
  return { operation, key, hit };
}

function exceptionContent(className: string, message: string): ExceptionContent {
  return { class: className, message, stack: null, context: {} };
}

function baseInput(type: string) {
  return {
    type,
    windowStart: start,
    windowEnd: end,
    windowMs,
    buckets: 60,
    slowMs: 100,
    truncated: false,
  };
}

describe('percentile', () => {
  it('returns nearest-rank values for [10,20,30,40,50]', () => {
    const values = [10, 20, 30, 40, 50];
    // idx = clamp(ceil(q*n)-1, 0, n-1), n=5
    expect(percentile(values, 0.5)).toBe(30); // ceil(2.5)-1 = 2 -> 30
    expect(percentile(values, 0.95)).toBe(50); // ceil(4.75)-1 = 4 -> 50
    expect(percentile(values, 0.99)).toBe(50); // ceil(4.95)-1 = 4 -> 50
    expect(percentile(values, 0)).toBe(10); // clamp(ceil(0)-1,0,4) = 0 -> 10
    expect(percentile(values, 1)).toBe(50); // ceil(5)-1 = 4 -> 50
  });

  it('returns 0 for an empty array', () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([], 0.99)).toBe(0);
  });

  it('handles a single element', () => {
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.99)).toBe(42);
    expect(percentile([42], 0)).toBe(42);
  });
});

describe('summarizeStats latency', () => {
  it('is present for query entries with durations and computes percentiles + slow', () => {
    const durations = [10, 20, 30, 40, 50, 60, 70, 80, 90, 200];
    const entries = durations.map((durationMs) =>
      entry<QueryContent>({
        type: EntryType.Query,
        durationMs,
        familyHash: 'fam',
        content: queryContent('select 1'),
      }),
    );
    const result = summarizeStats({ ...baseInput(EntryType.Query), entries });

    expect(result.latency).toBeDefined();
    expect(result.latency?.count).toBe(10);
    expect(result.latency?.max).toBe(200);
    // sorted ascending: 10..90,200 (n=10)
    expect(result.latency?.p50).toBe(percentile(durations, 0.5));
    expect(result.latency?.p95).toBe(percentile(durations, 0.95));
    expect(result.latency?.p99).toBe(percentile(durations, 0.99));
    // slow = count with durationMs >= slowMs(100) -> just 200
    expect(result.latency?.slow).toBe(1);
  });

  it('is omitted when no entry has a durationMs', () => {
    const entries = [
      entry<QueryContent>({
        type: EntryType.Query,
        durationMs: null,
        content: queryContent('select 1'),
      }),
    ];
    const result = summarizeStats({ ...baseInput(EntryType.Query), entries });
    expect(result.latency).toBeUndefined();
  });
});

describe('summarizeStats families', () => {
  it('orders families by p99 desc, truncates label to 60 chars, respects topFamilies', () => {
    const longSql = 'x'.repeat(120);
    function fam(familyHash: string, durations: number[], sql: string) {
      return durations.map((durationMs) =>
        entry<QueryContent>({
          type: EntryType.Query,
          durationMs,
          familyHash,
          content: queryContent(sql),
        }),
      );
    }
    const entries = [
      ...fam('a', [10, 10, 10], 'select a'),
      ...fam('b', [500, 500, 500], longSql),
      ...fam('c', [100, 100, 100], 'select c'),
      // null familyHash entries are skipped from families
      entry<QueryContent>({
        type: EntryType.Query,
        durationMs: 9999,
        familyHash: null,
        content: queryContent('orphan'),
      }),
    ];
    const result = summarizeStats({
      ...baseInput(EntryType.Query),
      entries,
      topFamilies: 2,
    });

    expect(result.families).toBeDefined();
    expect(result.families).toHaveLength(2);
    // p99 desc: b (500) then c (100); a (10) dropped by top-2
    expect(result.families?.[0]?.familyHash).toBe('b');
    expect(result.families?.[1]?.familyHash).toBe('c');
    expect(result.families?.[0]?.count).toBe(3);
    expect(result.families?.[0]?.label).toBe(longSql.slice(0, 60));
    expect(result.families?.[0]?.label.length).toBe(60);
  });

  it('extracts the family label from sql even when content omits slow/connection (e.g. MikroORM logger)', () => {
    // The MikroORM query logger emits { sql, bindings, took } — no `slow`. The
    // label must still come through (it only needs the sql text).
    const entries = [
      entry<{ sql: string; bindings: unknown[] }>({
        type: EntryType.Query,
        durationMs: 42,
        familyHash: 'fam-no-slow',
        content: { sql: 'select * from chunked_upload where status = ?', bindings: [] },
      }),
    ];
    const result = summarizeStats({ ...baseInput(EntryType.Query), entries });
    expect(result.families?.[0]?.label).toBe('select * from chunked_upload where status = ?');
  });

  it('tiebreaks equal p99 by count desc then familyHash asc', () => {
    function fam(familyHash: string, durations: number[]) {
      return durations.map((durationMs) =>
        entry<QueryContent>({
          type: EntryType.Query,
          durationMs,
          familyHash,
          content: queryContent('select x'),
        }),
      );
    }
    const entries = [
      ...fam('z', [100, 100]), // p99 100, count 2
      ...fam('a', [100, 100, 100]), // p99 100, count 3
      ...fam('m', [100, 100]), // p99 100, count 2
    ];
    const result = summarizeStats({ ...baseInput(EntryType.Query), entries });
    // count desc: a(3) first; then count 2 tie -> familyHash asc: m, z
    expect(result.families?.map((f) => f.familyHash)).toEqual(['a', 'm', 'z']);
  });
});

describe('summarizeStats cache', () => {
  it('computes hits/misses/sets/hitRatio and topKeys', () => {
    const entries = [
      entry<CacheContent>({ type: EntryType.Cache, content: cacheContent('get', 'k1', true) }),
      entry<CacheContent>({ type: EntryType.Cache, content: cacheContent('get', 'k1', true) }),
      entry<CacheContent>({ type: EntryType.Cache, content: cacheContent('get', 'k2', false) }),
      entry<CacheContent>({ type: EntryType.Cache, content: cacheContent('set', 'k1', null) }),
    ];
    const result = summarizeStats({ ...baseInput(EntryType.Cache), entries });
    expect(result.cache?.hits).toBe(2);
    expect(result.cache?.misses).toBe(1);
    expect(result.cache?.sets).toBe(1);
    expect(result.cache?.hitRatio).toBeCloseTo(2 / 3);
    // topKeys by occurrence: k1 (3) then k2 (1)
    expect(result.cache?.topKeys[0]).toEqual({ key: 'k1', count: 3 });
    expect(result.cache?.topKeys[1]).toEqual({ key: 'k2', count: 1 });
  });

  it('hitRatio is 0 when there are only sets', () => {
    const entries = [
      entry<CacheContent>({ type: EntryType.Cache, content: cacheContent('set', 'k1', null) }),
      entry<CacheContent>({ type: EntryType.Cache, content: cacheContent('set', 'k2', null) }),
    ];
    const result = summarizeStats({ ...baseInput(EntryType.Cache), entries });
    expect(result.cache?.hits).toBe(0);
    expect(result.cache?.misses).toBe(0);
    expect(result.cache?.sets).toBe(2);
    expect(result.cache?.hitRatio).toBe(0);
  });

  it('orders topKeys count desc then key asc', () => {
    const entries = [
      entry<CacheContent>({ type: EntryType.Cache, content: cacheContent('get', 'b', true) }),
      entry<CacheContent>({ type: EntryType.Cache, content: cacheContent('get', 'a', true) }),
    ];
    const result = summarizeStats({ ...baseInput(EntryType.Cache), entries });
    // both count 1 -> key asc
    expect(result.cache?.topKeys.map((k) => k.key)).toEqual(['a', 'b']);
  });
});

describe('summarizeStats status', () => {
  it('buckets statusCode into 2xx/3xx/4xx/5xx/other', () => {
    const codes = [200, 201, 301, 404, 500, null];
    const entries = codes.map((statusCode) =>
      entry<RequestContent>({
        type: EntryType.Request,
        durationMs: 5,
        content: requestContent(statusCode),
      }),
    );
    const result = summarizeStats({ ...baseInput(EntryType.Request), entries });
    expect(result.status).toEqual({
      '2xx': 2,
      '3xx': 1,
      '4xx': 1,
      '5xx': 1,
      other: 1,
    });
  });
});

describe('summarizeStats exceptions', () => {
  function exc(
    familyHash: string,
    className: string,
    message: string,
    createdAt: Date,
  ): Entry<ExceptionContent> {
    return entry<ExceptionContent>({
      type: EntryType.Exception,
      familyHash,
      content: exceptionContent(className, message),
      createdAt,
    });
  }

  it('groups exceptions by family key with count, lastAt, class/message and over-time', () => {
    const t = (min: number) => new Date(start.getTime() + min * 60_000);
    const entries = [
      // TypeError group: 3 occurrences, last at minute 50
      exc('TypeError:boom', 'TypeError', 'boom', t(10)),
      exc('TypeError:boom', 'TypeError', 'boom', t(30)),
      exc('TypeError:boom', 'TypeError', 'boom', t(50)),
      // RangeError group: 2 occurrences, last at minute 20
      exc('RangeError:nope', 'RangeError', 'nope', t(5)),
      exc('RangeError:nope', 'RangeError', 'nope', t(20)),
    ];
    const result = summarizeStats({ ...baseInput(EntryType.Exception), entries, buckets: 6 });

    expect(result.exceptions).toBeDefined();
    expect(result.exceptions).toHaveLength(2);
    // Sorted by count desc -> TypeError (3) first.
    const [first, second] = result.exceptions ?? [];
    expect(first?.key).toBe('TypeError:boom');
    expect(first?.class).toBe('TypeError');
    expect(first?.message).toBe('boom');
    expect(first?.count).toBe(3);
    expect(first?.lastAt).toEqual(t(50));
    expect(second?.key).toBe('RangeError:nope');
    expect(second?.count).toBe(2);
    expect(second?.lastAt).toEqual(t(20));
    // overTime aligned to 6 buckets (10-min each): TypeError at buckets 1,3,5.
    expect(first?.overTime).toHaveLength(6);
    expect(first?.overTime?.[1]).toBe(1);
    expect(first?.overTime?.[3]).toBe(1);
    expect(first?.overTime?.[5]).toBe(1);
    expect(second?.overTime?.[0]).toBe(1);
    expect(second?.overTime?.[2]).toBe(1);
  });

  it('tiebreaks equal counts by lastAt desc and respects topExceptions', () => {
    const t = (min: number) => new Date(start.getTime() + min * 60_000);
    const entries = [
      exc('a:a', 'A', 'a', t(10)),
      exc('b:b', 'B', 'b', t(40)),
      exc('c:c', 'C', 'c', t(20)),
    ];
    const result = summarizeStats({
      ...baseInput(EntryType.Exception),
      entries,
      topExceptions: 2,
    });
    expect(result.exceptions).toHaveLength(2);
    // All count 1 -> lastAt desc: b(40), c(20); a(10) dropped by top-2.
    expect(result.exceptions?.map((group) => group.key)).toEqual(['b:b', 'c:c']);
  });

  it('falls back to `class: message` key when familyHash is null', () => {
    const entries = [
      entry<ExceptionContent>({
        type: EntryType.Exception,
        familyHash: null,
        content: exceptionContent('TypeError', 'boom'),
      }),
      entry<ExceptionContent>({
        type: EntryType.Exception,
        familyHash: null,
        content: exceptionContent('TypeError', 'boom'),
      }),
    ];
    const result = summarizeStats({ ...baseInput(EntryType.Exception), entries });
    expect(result.exceptions).toHaveLength(1);
    expect(result.exceptions?.[0]?.key).toBe('TypeError: boom');
    expect(result.exceptions?.[0]?.count).toBe(2);
  });

  it('is omitted for non-exception types', () => {
    const entries = [
      entry<QueryContent>({
        type: EntryType.Query,
        durationMs: 1,
        familyHash: 'f',
        content: queryContent('select 1'),
      }),
    ];
    const result = summarizeStats({ ...baseInput(EntryType.Query), entries });
    expect(result.exceptions).toBeUndefined();
  });
});

describe('summarizeStats general', () => {
  it('handles empty entries: total 0, type-specific omitted, overTime present', () => {
    const result = summarizeStats({ ...baseInput(EntryType.Query), entries: [] });
    expect(result.total).toBe(0);
    expect(result.type).toBe(EntryType.Query);
    expect(result.windowMs).toBe(windowMs);
    expect(result.truncated).toBe(false);
    expect(result.latency).toBeUndefined();
    expect(result.families).toBeUndefined();
    expect(result.cache).toBeUndefined();
    expect(result.status).toBeUndefined();
    expect(result.overTime).toBeDefined();
    expect(result.overTime.buckets).toHaveLength(60);
  });

  it('passes through truncated and reports total', () => {
    const entries = [
      entry<QueryContent>({
        type: EntryType.Query,
        durationMs: 1,
        familyHash: 'f',
        content: queryContent('select 1'),
      }),
    ];
    const result = summarizeStats({ ...baseInput(EntryType.Query), entries, truncated: true });
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(1);
  });

  it('only emits families for query, status for request, cache for cache', () => {
    const reqEntries = [
      entry<RequestContent>({
        type: EntryType.Request,
        durationMs: 5,
        content: requestContent(200),
      }),
    ];
    const reqResult = summarizeStats({ ...baseInput(EntryType.Request), entries: reqEntries });
    expect(reqResult.families).toBeUndefined();
    expect(reqResult.cache).toBeUndefined();
    expect(reqResult.status).toBeDefined();
    expect(reqResult.latency).toBeDefined();
  });
});
