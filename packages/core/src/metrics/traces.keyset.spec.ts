// packages/core/src/metrics/traces.keyset.spec.ts
//
// The traces list by keyset gives, page after page, exactly what grouping the whole window gives
// (the old method), on the memory and SQLite stores.
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { SqliteStorageProvider } from '../storage/sqlite-storage-provider.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { type TraceSummary, summarizeTraces } from './traces.js';
import { TracesService, decodeTracesCursor, encodeTracesCursor } from './traces.service.js';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const WINDOW = 3_600_000;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

/** A small deterministic PRNG, so a failure reproduces. */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

let seq = 0;
function entry(
  type: string,
  traceId: string | null,
  at: number,
  extra: Partial<Entry> = {},
): Entry {
  seq += 1;
  return {
    id: `e-${String(seq).padStart(7, '0')}`,
    batchId: `b-${seq}`,
    type,
    familyHash: null,
    content: type === 'request' ? { method: 'GET', uri: `/r/${traceId}` } : { sql: 'select 1' },
    tags: traceId !== null && seq % 3 === 0 ? ['app:shop'] : [],
    sequence: 0,
    durationMs: seq % 7 === 0 ? null : seq % 50,
    origin: 'http',
    instanceId: 'i',
    traceId,
    spanId: null,
    createdAt: new Date(at),
    ...extra,
  };
}

/**
 * Traces of 1–12 entries spread over up to a few seconds (some over minutes), untraced noise
 * between them, ties on the same millisecond, and traces that started before the window.
 */
function dataset(seed: number, traces: number): Entry[] {
  const random = rng(seed);
  const rows: Entry[] = [];
  for (let t = 0; t < traces; t++) {
    const traceId = `trace-${String(Math.floor(random() * 1e6)).padStart(6, '0')}-${t}`;
    // Every 9th trace shares the newest millisecond of the one before (a tie).
    const end =
      t % 9 === 0 && t > 0
        ? NOW - Math.floor((t - 1) * 900)
        : NOW - Math.floor(t * 900 + random() * 400);
    const count = 1 + Math.floor(random() * 12);
    const spread = t % 11 === 0 ? 600_000 : 3_000;
    rows.push(entry('request', traceId, end - Math.floor(random() * 5)));
    for (let i = 1; i < count; i++)
      rows.push(entry('query', traceId, end - Math.floor(random() * spread)));
    // Some traces began before the window: those entries are not counted.
    if (t % 13 === 0) rows.push(entry('job', traceId, NOW - WINDOW - 10_000));
    for (let n = 0; n < 3; n++) rows.push(entry('log', null, end - Math.floor(random() * 900)));
  }
  return rows;
}

/** The old method: group every entry of the window, most recently active first (ties by id). */
function grouped(rows: Entry[]): TraceSummary[] {
  const inWindow = rows.filter((row) => row.createdAt.getTime() > NOW - WINDOW);
  return summarizeTraces(inWindow, { limit: Number.MAX_SAFE_INTEGER }).sort(
    (a, b) =>
      b.lastAt.getTime() - a.lastAt.getTime() ||
      (a.traceId < b.traceId ? 1 : a.traceId > b.traceId ? -1 : 0),
  );
}

async function walkAll(service: TracesService, size: number) {
  const pages: TraceSummary[][] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 1000; guard++) {
    const page = await service.getTraces({
      windowMs: WINDOW,
      limit: size,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    pages.push(page.traces);
    expect(page.truncated).toBe(false);
    expect(page.hasNext).toBe(page.nextCursor !== null);
    if (!page.hasNext) break;
    cursor = page.nextCursor ?? undefined;
  }
  return pages;
}

const stores: [string, () => StorageProvider][] = [
  ['memory', () => new InMemoryStorageProvider()],
  ['sqlite', () => new SqliteStorageProvider({ path: ':memory:' })],
];

describe.each(stores)('traces by keyset (%s)', (_, make) => {
  it.each([1, 3, 7, 50])(
    'pages of %i give exactly the grouping of the whole window',
    async (size) => {
      const store = make();
      const rows = dataset(size * 31 + 7, 120);
      await store.store(rows);
      const pages = await walkAll(new TracesService(store), size);
      const expected = grouped(rows);
      const got = pages.flat();
      expect(got.map((trace) => trace.traceId)).toEqual(expected.map((trace) => trace.traceId));
      for (const [index, trace] of got.entries()) {
        const want = expected[index] as TraceSummary;
        expect({ ...trace, rootLabel: undefined }).toEqual({ ...want, rootLabel: undefined });
        expect(trace.rootLabel).toBe(`GET /r/${trace.traceId}`);
      }
      // Every page but the last is full; none is empty.
      for (const page of pages.slice(0, -1)) expect(page).toHaveLength(size);
      expect(pages.at(-1)?.length).toBeGreaterThan(0);
      await store.close?.();
    },
  );

  it('a trace that becomes active again between pages is not shown twice', async () => {
    const store = make();
    const rows = dataset(99, 30);
    await store.store(rows);
    const service = new TracesService(store);
    const first = await service.getTraces({ windowMs: WINDOW, limit: 10 });
    const second = await service.getTraces({
      windowMs: WINDOW,
      limit: 10,
      cursor: first.nextCursor ?? '',
    });
    // A trace of the second page records again.
    const revived = second.traces[4]?.traceId as string;
    await store.store([entry('query', revived, NOW - 1)]);
    const shown = new Set(first.traces.map((trace) => trace.traceId));
    let cursor = second.nextCursor;
    for (const trace of second.traces) shown.add(trace.traceId);
    while (cursor !== null) {
      const page = await service.getTraces({ windowMs: WINDOW, limit: 10, cursor });
      for (const trace of page.traces) {
        expect(shown.has(trace.traceId)).toBe(false);
        shown.add(trace.traceId);
      }
      cursor = page.nextCursor;
    }
    // It is on the first page now.
    const again = await service.getTraces({ windowMs: WINDOW, limit: 10 });
    expect(again.traces[0]?.traceId).toBe(revived);
    await store.close?.();
  });

  it('reads about the page, not the window', async () => {
    const store = make();
    const rows = dataset(5, 400);
    await store.store(rows);
    const page = await new TracesService(store).getTraces({ windowMs: WINDOW, limit: 10 });
    const inWindow = rows.filter((row) => row.createdAt.getTime() > NOW - WINDOW).length;
    expect(page.scanned).toBeLessThan(inWindow / 5);
    expect(page.hasNext).toBe(true);
    await store.close?.();
  });
});

describe('trace labels', () => {
  it('reads one request per trace, in batches of at most 100 ids', async () => {
    const store = new InMemoryStorageProvider();
    const rows: Entry[] = [];
    for (let t = 0; t < 250; t++) {
      // Two requests per trace: only the one the label comes from is read.
      rows.push(entry('request', `tr-${t}`, NOW - t * 1000));
      rows.push(entry('request', `tr-${t}`, NOW - t * 1000 - 1));
    }
    await store.store(rows);
    const get = vi.spyOn(store, 'get');
    const page = await new TracesService(store).getTraces({ windowMs: WINDOW, limit: 250 });
    expect(page.traces.every((trace) => trace.rootLabel === `GET /r/${trace.traceId}`)).toBe(true);
    const byId = get.mock.calls.map(([query]) => query.ids).filter((ids) => ids !== undefined);
    expect(byId.map((ids) => ids.length)).toEqual([100, 100, 50]);
  });
});

describe('traces cursor', () => {
  it('round-trips, and rejects anything else', () => {
    const key = { traceId: 'abc', lastAt: NOW };
    expect(decodeTracesCursor(encodeTracesCursor(key))).toEqual(key);
    for (const bad of ['', 'nope', Buffer.from('["t","x","a"]').toString('base64url')]) {
      expect(() => decodeTracesCursor(bad)).toThrow('Invalid traces cursor.');
    }
  });

  it('a walk cut by the scan cap places only the traces it can, and pages on', async () => {
    const store = new InMemoryStorageProvider();
    const rows = dataset(3, 60);
    await store.store(rows);
    const service = new TracesService(store, { scanCap: 40 });
    const all: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 500; guard++) {
      const page = await service.getTraces({
        windowMs: WINDOW,
        limit: 25,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      all.push(...page.traces.map((trace) => trace.traceId));
      if (!page.hasNext) break;
      cursor = page.nextCursor ?? undefined;
    }
    expect(all).toEqual(grouped(rows).map((trace) => trace.traceId));
  });
});
