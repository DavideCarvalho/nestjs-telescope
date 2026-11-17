// packages/core/src/config/volume.spec.ts
//
// The `query` / `cache` volume knobs, end to end through the Recorder: per-trace sampling (a kept
// request keeps all its queries), slow and failed queries surviving it, the minMs floor, cache
// misses/writes/deletes/clears always kept, and the ignore lists.
import { describe, expect, it, vi } from 'vitest';
import { createBatch } from '../context/batch.js';
import { TelescopeContext } from '../context/telescope-context.js';
import type { RecordInput } from '../entry/entry.js';
import { Recorder, type RecorderOptions } from '../recorder/recorder.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { resolveConfig } from './resolve-config.js';
import { keepByTrace, traceUnit } from './volume.js';

function makeRecorder(over: Partial<RecorderOptions> = {}) {
  const storage = new InMemoryStorageProvider();
  const context = new TelescopeContext();
  let counter = 0;
  const recorder = new Recorder({
    storage,
    context,
    instanceId: 'pod-1',
    taggers: [],
    redact: {},
    sampling: {},
    bufferSize: 10_000,
    now: () => 1_000,
    delay: () => Promise.resolve(),
    idFactory: () => `id-${counter++}`,
    ...over,
  });
  return { recorder, storage };
}

const query = (sql: string, over: Partial<RecordInput> = {}): RecordInput => ({
  type: 'query',
  content: { sql, bindings: [] },
  durationMs: 2,
  ...over,
});

const cache = (content: Record<string, unknown>): RecordInput => ({ type: 'cache', content });

async function stored(recorder: Recorder, storage: InMemoryStorageProvider) {
  await recorder.flush();
  // Read back in record order (ids are `id-<counter>`).
  const order = (id: string) => Number(id.slice('id-'.length));
  return (await storage.get({ limit: 10_000 })).data.sort((a, b) => order(a.id) - order(b.id));
}

/** Trace ids whose hash is below / above `rate`, so a test knows which one sampling keeps. */
function traceIds(rate: number): { kept: string; dropped: string } {
  let kept: string | undefined;
  let dropped: string | undefined;
  for (let index = 0; kept === undefined || dropped === undefined; index++) {
    const id = `trace-${index}`;
    if (traceUnit(id) < rate) kept ??= id;
    else dropped ??= id;
  }
  return { kept, dropped };
}

describe('keepByTrace', () => {
  it('decides the same way for every entry of a trace, nested across rates', () => {
    const ids = Array.from({ length: 200 }, (_, index) => `t-${index}`);
    const never = () => {
      throw new Error('random must not be used when there is a trace key');
    };
    for (const id of ids) {
      const first = keepByTrace(id, 0.3, never);
      expect(keepByTrace(id, 0.3, never)).toBe(first);
      // A trace kept at a lower rate is kept at any higher one.
      if (first) expect(keepByTrace(id, 0.6, never)).toBe(true);
    }
    const kept = ids.filter((id) => keepByTrace(id, 0.3, never)).length;
    expect(kept).toBeGreaterThan(10);
    expect(kept).toBeLessThan(120);
  });

  it('falls back to random without a key, and short-circuits rates 0 and 1', () => {
    expect(keepByTrace(null, 0.5, () => 0.4)).toBe(true);
    expect(keepByTrace(null, 0.5, () => 0.6)).toBe(false);
    expect(keepByTrace('x', 1, () => 1)).toBe(true);
    expect(keepByTrace('x', 0, () => 0)).toBe(false);
  });
});

describe('query volume knobs', () => {
  it('samples per trace: a kept trace keeps ALL its queries, a dropped one keeps none', async () => {
    const { kept, dropped } = traceIds(0.5);
    // A random source that would split the queries of one trace if it were consulted per entry.
    let flip = 0;
    const { recorder, storage } = makeRecorder({
      query: { sampleRate: 0.5 },
      random: () => (flip++ % 2 === 0 ? 0.1 : 0.9),
    });
    for (let index = 0; index < 10; index++) {
      recorder.record(query(`select * from orders where id = ${index}`, { traceId: kept }));
      recorder.record(query(`select * from orders where id = ${index}`, { traceId: dropped }));
    }
    const entries = await stored(recorder, storage);
    expect(entries.filter((entry) => entry.traceId === kept)).toHaveLength(10);
    expect(entries.filter((entry) => entry.traceId === dropped)).toHaveLength(0);
  });

  it('samples per request batch when there is no trace id', async () => {
    const { recorder, storage } = makeRecorder({ query: { sampleRate: 0.5 } });
    const context = (recorder as unknown as { options: { context: TelescopeContext } }).options
      .context;
    const batches: string[] = [];
    for (let index = 0; index < 20; index++) {
      const batch = createBatch('http', () => `batch-${index}`);
      batches.push(batch.id);
      await context.run(batch, async () => {
        for (let n = 0; n < 5; n++) recorder.record(query('select 1'));
      });
    }
    const entries = await stored(recorder, storage);
    const perBatch = new Map<string, number>();
    for (const entry of entries)
      perBatch.set(entry.batchId, (perBatch.get(entry.batchId) ?? 0) + 1);
    // Every batch is all-or-nothing.
    for (const count of perBatch.values()) expect(count).toBe(5);
    expect(perBatch.size).toBeGreaterThan(0);
    expect(perBatch.size).toBeLessThan(20);
  });

  it('always keeps slow and failed queries of a sampled-out trace', async () => {
    const { dropped } = traceIds(0.5);
    const { recorder, storage } = makeRecorder({ query: { sampleRate: 0.5 } });
    recorder.record(query('select fast', { traceId: dropped }));
    recorder.record(query('select slow', { traceId: dropped, durationMs: 1500, tags: ['slow'] }));
    recorder.record(query('select broken', { traceId: dropped, tags: ['failed'] }));
    const sqls = (await stored(recorder, storage)).map(
      (entry) => (entry.content as { sql: string }).sql,
    );
    expect(sqls.sort()).toEqual(['select broken', 'select slow']);
  });

  it('sampleRate 0 drops every ordinary query but keeps slow ones', async () => {
    const { recorder, storage } = makeRecorder({ query: { sampleRate: 0 } });
    recorder.record(query('select a', { traceId: 't' }));
    recorder.record(query('select b', { tags: ['slow'], durationMs: 5000 }));
    const entries = await stored(recorder, storage);
    expect(entries.map((entry) => (entry.content as { sql: string }).sql)).toEqual(['select b']);
  });

  it('minMs drops fast queries, keeps slower and duration-less ones', async () => {
    const { recorder, storage } = makeRecorder({ query: { minMs: 10 } });
    recorder.record(query('select fast', { durationMs: 3 }));
    recorder.record(query('select ok', { durationMs: 12 }));
    recorder.record(query('select unknown', { durationMs: null }));
    recorder.record(query('select fast slow-tagged', { durationMs: 3, tags: ['slow'] }));
    const sqls = (await stored(recorder, storage)).map(
      (entry) => (entry.content as { sql: string }).sql,
    );
    expect(sqls.sort()).toEqual(['select fast slow-tagged', 'select ok', 'select unknown']);
  });

  it('reports a sampled-out query to onSampled as not kept', () => {
    const onSampled = vi.fn();
    const { recorder } = makeRecorder({ query: { sampleRate: 0 }, onSampled });
    recorder.record(query('select a', { traceId: 't' }));
    expect(onSampled).toHaveBeenCalledWith(expect.objectContaining({ type: 'query' }), false);
  });

  it('ignoreTables drops statements on those tables, schema and quoting aside', async () => {
    const { recorder, storage } = makeRecorder({
      query: { ignoreTables: ['durable_workflow_runs', ''] },
    });
    recorder.record(query('select * from "public"."durable_workflow_runs" where id = $1'));
    recorder.record(query('UPDATE durable_workflow_runs SET status = ?'));
    recorder.record(query('insert into `durable_workflow_runs` (id) values (?)'));
    recorder.record(query('SELECT id,\n  status\nFROM\n  "durable_workflow_runs"\nWHERE id = $1'));
    recorder.record(query('/* poller */ -- tick\nselect * from durable_workflow_runs'));
    recorder.record(query('(select * from public.durable_workflow_runs) union (select 1)'));
    recorder.record(query('select * from orders join durable_workflow_runs on 1=1'));
    recorder.record(query('select * from durable_workflow_runs_archive'));
    const sqls = (await stored(recorder, storage)).map(
      (entry) => (entry.content as { sql: string }).sql,
    );
    expect(sqls).toEqual([
      'select * from orders join durable_workflow_runs on 1=1',
      'select * from durable_workflow_runs_archive',
    ]);
  });

  it('leaves non-query entries alone', async () => {
    const { recorder, storage } = makeRecorder({ query: { sampleRate: 0, minMs: 100 } });
    recorder.record({ type: 'request', content: { uri: '/' }, durationMs: 1 });
    expect(await stored(recorder, storage)).toHaveLength(1);
  });
});

describe('cache volume knobs', () => {
  it('hitSampleRate samples hits per trace; misses, writes, deletes and clears are always kept', async () => {
    const { kept, dropped } = traceIds(0.5);
    const { recorder, storage } = makeRecorder({ cache: { hitSampleRate: 0.5 } });
    for (const traceId of [kept, dropped]) {
      for (const content of [
        { operation: 'get', key: 'a', hit: true },
        { operation: 'get', key: 'a', hit: true },
        { operation: 'get', key: 'b', hit: false },
        { operation: 'set', key: 'b', hit: null },
        { operation: 'delete', key: 'b', hit: null },
        { operation: 'clear', key: '*', hit: null },
      ]) {
        recorder.record({ ...cache(content), traceId });
      }
    }
    const entries = await stored(recorder, storage);
    const ops = (traceId: string) =>
      entries
        .filter((entry) => entry.traceId === traceId)
        .map((entry) => {
          const content = entry.content as { operation: string; hit: boolean | null };
          return content.operation === 'get' ? `get:${content.hit}` : content.operation;
        });
    expect(ops(kept)).toEqual(['get:true', 'get:true', 'get:false', 'set', 'delete', 'clear']);
    expect(ops(dropped)).toEqual(['get:false', 'set', 'delete', 'clear']);
  });

  it('ignoreStores drops operations on those stores (case-insensitive)', async () => {
    const { recorder, storage } = makeRecorder({ cache: { ignoreStores: ['Sessions'] } });
    recorder.record(cache({ operation: 'set', key: 'a', hit: null, store: 'sessions' }));
    recorder.record(cache({ operation: 'set', key: 'a', hit: null, store: 'default' }));
    recorder.record(cache({ operation: 'set', key: 'a', hit: null }));
    const stores = (await stored(recorder, storage)).map(
      (entry) => (entry.content as { store?: string }).store ?? null,
    );
    expect(stores).toEqual(['default', null]);
  });

  it('ignoreKeys drops keys by prefix or RegExp; an empty prefix is skipped', async () => {
    const { recorder, storage } = makeRecorder({
      cache: { ignoreKeys: ['', 'rate-limit:', /^lock:.+:\d+$/g] },
    });
    for (const key of ['rate-limit:1.2.3.4', 'lock:job:7', 'lock:job:8', 'user:1', 'lock:x']) {
      recorder.record(cache({ operation: 'get', key, hit: false }));
    }
    const keys = (await stored(recorder, storage)).map(
      (entry) => (entry.content as { key: string }).key,
    );
    expect(keys).toEqual(['user:1', 'lock:x']);
  });
});

describe('resolveConfig volume knobs', () => {
  it('keeps today’s behaviour when unset', () => {
    const resolved = resolveConfig({});
    expect(resolved.query).toBeUndefined();
    expect(resolved.cache).toBeUndefined();
  });

  it('copies the knobs and rejects out-of-range rates at boot', () => {
    const resolved = resolveConfig({
      query: { sampleRate: 0.2, minMs: 5, ignoreTables: ['jobs'] },
      cache: { hitSampleRate: 0.1, ignoreStores: ['s'], ignoreKeys: [/x/] },
    });
    expect(resolved.query).toEqual({ sampleRate: 0.2, minMs: 5, ignoreTables: ['jobs'] });
    expect(resolved.cache).toEqual({ hitSampleRate: 0.1, ignoreStores: ['s'], ignoreKeys: [/x/] });
    expect(() => resolveConfig({ query: { sampleRate: 2 } })).toThrow();
    expect(() => resolveConfig({ query: { minMs: -1 } })).toThrow();
    expect(() => resolveConfig({ cache: { hitSampleRate: -0.5 } })).toThrow();
  });
});
