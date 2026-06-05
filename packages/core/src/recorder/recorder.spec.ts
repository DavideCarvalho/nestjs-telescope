// packages/core/src/recorder/recorder.spec.ts
import { describe, expect, it, vi } from 'vitest';
import { createBatch } from '../context/batch.js';
import { TelescopeContext } from '../context/telescope-context.js';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { Recorder } from './recorder.js';

function makeRecorder(over: Partial<ConstructorParameters<typeof Recorder>[0]> = {}) {
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
    bufferSize: 100,
    now: () => 1_000,
    random: () => 0,
    // Default to an instant backoff so the bounded store-retry never parks a
    // real timer in tests. Individual cases override `delay` to drive timing.
    delay: () => Promise.resolve(),
    idFactory: () => `id-${counter++}`,
    ...over,
  });
  return { recorder, storage, context };
}

/** A StorageProvider whose store() resolves only when you call resolve(). */
function makeDeferredStorage(): {
  storage: StorageProvider;
  resolve: () => void;
  storeCallCount: () => number;
} {
  let callCount = 0;
  let resolveFn: (() => void) | null = null;
  const storage: StorageProvider = {
    store: (_entries: Entry[]): Promise<void> => {
      callCount += 1;
      return new Promise<void>((resolve) => {
        resolveFn = resolve;
      });
    },
    update: () => Promise.resolve(),
    find: () => Promise.resolve(null),
    get: () => Promise.resolve({ data: [], nextCursor: null }),
    batch: () => Promise.resolve([]),
    tags: () => Promise.resolve([]),
    prune: () => Promise.resolve(0),
    clear: () => Promise.resolve(),
  };
  return {
    storage,
    resolve: () => resolveFn?.(),
    storeCallCount: () => callCount,
  };
}

describe('Recorder', () => {
  it('enriches an input into an entry with batch id, sequence, instance id', async () => {
    const { recorder, storage, context } = makeRecorder();
    await context.run(
      createBatch(
        'http',
        () => 'batch-1',
        () => 1_000,
      ),
      async () => {
        recorder.record({ type: 'request', content: { statusCode: 200 } });
      },
    );
    await recorder.flush();

    const page = await storage.get({});
    expect(page.data).toHaveLength(1);
    const entry = page.data[0]!;
    expect(entry.batchId).toBe('batch-1');
    expect(entry.sequence).toBe(0);
    expect(entry.instanceId).toBe('pod-1');
    expect(entry.origin).toBe('http');
    expect(entry.createdAt).toEqual(new Date(1_000));
  });

  it('redacts content and applies taggers before storing', async () => {
    const { recorder, storage } = makeRecorder({
      taggers: [(e) => [`type:${e.type}`]],
    });
    recorder.record({ type: 'request', content: { password: 'secret', statusCode: 200 } });
    await recorder.flush();

    const entry = (await storage.get({})).data[0]!;
    expect((entry.content as any).password).toBe('[REDACTED]');
    expect(entry.tags).toContain('type:request');
  });

  it('gives entries outside any batch a synthetic batch id', async () => {
    const { recorder, storage } = makeRecorder();
    recorder.record({ type: 'exception', content: {} });
    await recorder.flush();
    expect((await storage.get({})).data[0]!.batchId).toBe('id-0');
  });

  it('drops by sampling rate without blocking', async () => {
    const { recorder, storage } = makeRecorder({ sampling: { query: 0 }, random: () => 0.5 });
    recorder.record({ type: 'query', content: {} });
    await recorder.flush();
    expect((await storage.get({})).data).toHaveLength(0);
  });

  it('drops oldest and counts when the buffer overflows', async () => {
    const { recorder, storage } = makeRecorder({ bufferSize: 2 });
    recorder.record({ type: 'request', content: { n: 1 } });
    recorder.record({ type: 'request', content: { n: 2 } });
    recorder.record({ type: 'request', content: { n: 3 } });
    expect(recorder.droppedCount).toBe(1);
    await recorder.flush();
    const stored = (await storage.get({})).data.map((e) => (e.content as any).n).sort();
    expect(stored).toEqual([2, 3]);
  });

  it('flush is a no-op when the buffer is empty', async () => {
    const { recorder } = makeRecorder();
    await expect(recorder.flush()).resolves.toBeUndefined();
  });

  // ── NEW TESTS ─────────────────────────────────────────────────────────────

  it('serializes concurrent flush() calls: store is invoked only once while in-flight', async () => {
    const { storage, resolve, storeCallCount } = makeDeferredStorage();
    const { recorder } = makeRecorder({ storage });

    recorder.record({ type: 'request', content: { n: 1 } });

    const p1 = recorder.flush();
    const p2 = recorder.flush(); // second call while first is in-flight

    // store must have been called exactly once so far
    expect(storeCallCount()).toBe(1);

    resolve(); // unblock the in-flight store
    await Promise.all([p1, p2]);

    // still only one store call
    expect(storeCallCount()).toBe(1);
  });

  // ── Flush retry with bounded backoff ──────────────────────────────────────

  describe('flush retry', () => {
    it('retries once after a store failure and stores on the second attempt; counts retriedFlushes', async () => {
      let attempt = 0;
      const failingThenOk: StorageProvider = {
        store: () => {
          attempt += 1;
          return attempt === 1 ? Promise.reject(new Error('transient')) : Promise.resolve();
        },
        update: () => Promise.resolve(),
        find: () => Promise.resolve(null),
        get: () => Promise.resolve({ data: [], nextCursor: null }),
        batch: () => Promise.resolve([]),
        tags: () => Promise.resolve([]),
        prune: () => Promise.resolve(0),
        clear: () => Promise.resolve(),
      };
      const delay = vi.fn(() => Promise.resolve());
      const { recorder } = makeRecorder({ storage: failingThenOk, delay });

      recorder.record({ type: 'request', content: { n: 1 } });
      await recorder.flush();

      // store() called exactly twice (fail, then succeed), with one backoff.
      expect(attempt).toBe(2);
      expect(delay).toHaveBeenCalledTimes(1);
      // The batch persisted, so nothing was dropped.
      expect(recorder.storeFailedDropped).toBe(0);
      expect(recorder.droppedCount).toBe(0);
      expect(recorder.getSelfMetrics().retriedFlushes).toBe(1);
    });

    it('honors the configured retryDelayMs as the backoff', async () => {
      let attempt = 0;
      const failingThenOk: StorageProvider = {
        store: () => {
          attempt += 1;
          return attempt === 1 ? Promise.reject(new Error('transient')) : Promise.resolve();
        },
        update: () => Promise.resolve(),
        find: () => Promise.resolve(null),
        get: () => Promise.resolve({ data: [], nextCursor: null }),
        batch: () => Promise.resolve([]),
        tags: () => Promise.resolve([]),
        prune: () => Promise.resolve(0),
        clear: () => Promise.resolve(),
      };
      const delay = vi.fn(() => Promise.resolve());
      const { recorder } = makeRecorder({ storage: failingThenOk, delay, retryDelayMs: 250 });

      recorder.record({ type: 'request', content: {} });
      await recorder.flush();

      expect(delay).toHaveBeenCalledWith(250);
    });

    it('drops and counts after the retry also fails (two failures total)', async () => {
      let attempt = 0;
      const onDrop = vi.fn();
      const alwaysFailing: StorageProvider = {
        store: () => {
          attempt += 1;
          return Promise.reject(new Error('disk full'));
        },
        update: () => Promise.resolve(),
        find: () => Promise.resolve(null),
        get: () => Promise.resolve({ data: [], nextCursor: null }),
        batch: () => Promise.resolve([]),
        tags: () => Promise.resolve([]),
        prune: () => Promise.resolve(0),
        clear: () => Promise.resolve(),
      };
      const delay = vi.fn(() => Promise.resolve());
      const { recorder } = makeRecorder({ storage: alwaysFailing, delay, onDrop });

      recorder.record({ type: 'request', content: {} });
      recorder.record({ type: 'request', content: {} });
      await recorder.flush();

      // Two store attempts (initial + one retry), then drop the whole batch.
      expect(attempt).toBe(2);
      expect(recorder.getSelfMetrics().retriedFlushes).toBe(1);
      expect(recorder.storeFailedDropped).toBe(2);
      expect(recorder.droppedCount).toBe(2);
      expect(onDrop).toHaveBeenCalledWith(2, 'store-failed');
    });

    it('does not pile up flushes during a retry: the ring keeps absorbing and a concurrent flush() shares the in-flight promise', async () => {
      let storeCalls = 0;
      let releaseRetry: (() => void) | null = null;
      // First store rejects; the backoff delay is gated on releaseRetry() so we
      // can drive records into the ring WHILE the single flush is mid-retry.
      const failingThenOk: StorageProvider = {
        store: () => {
          storeCalls += 1;
          return storeCalls === 1 ? Promise.reject(new Error('transient')) : Promise.resolve();
        },
        update: () => Promise.resolve(),
        find: () => Promise.resolve(null),
        get: () => Promise.resolve({ data: [], nextCursor: null }),
        batch: () => Promise.resolve([]),
        tags: () => Promise.resolve([]),
        prune: () => Promise.resolve(0),
        clear: () => Promise.resolve(),
      };
      // Resolves once the flush has reached the backoff (i.e. first store failed).
      let signalDelayReached: (() => void) | null = null;
      const delayReached = new Promise<void>((resolve) => {
        signalDelayReached = resolve;
      });
      const delay = (): Promise<void> =>
        new Promise<void>((resolve) => {
          releaseRetry = resolve;
          signalDelayReached?.();
        });
      const { recorder } = makeRecorder({ storage: failingThenOk, delay });

      recorder.record({ type: 'request', content: { n: 1 } });
      const flushPromise = recorder.flush();

      // Wait until the flush is parked inside the backoff after its first failure.
      await delayReached;

      // A second flush() must NOT start a new store — it shares the in-flight one.
      const concurrent = recorder.flush();
      // The ring keeps absorbing new records meanwhile.
      recorder.record({ type: 'request', content: { n: 2 } });
      expect(storeCalls).toBe(1);

      releaseRetry?.(); // let the retry proceed (and succeed)
      await Promise.all([flushPromise, concurrent]);

      // Exactly initial + retry = 2 store calls for the single batch; no pileup.
      expect(storeCalls).toBe(2);
      expect(recorder.getSelfMetrics().retriedFlushes).toBe(1);
      // The record that arrived during the retry is still buffered for next flush.
      expect(recorder.getSelfMetrics().bufferUsed).toBe(1);
    });
  });

  it('overflowDropped and storeFailedDropped track separate buckets; droppedCount is their sum', async () => {
    // overflow: bufferSize 2, push 3 entries
    const { recorder: r1 } = makeRecorder({ bufferSize: 2 });
    r1.record({ type: 'request', content: {} });
    r1.record({ type: 'request', content: {} });
    r1.record({ type: 'request', content: {} });
    expect(r1.overflowDropped).toBe(1);
    expect(r1.storeFailedDropped).toBe(0);
    expect(r1.droppedCount).toBe(1);

    // store-failure: rejecting storage
    const failingStorage: StorageProvider = {
      store: () => Promise.reject(new Error('disk full')),
      update: () => Promise.resolve(),
      find: () => Promise.resolve(null),
      get: () => Promise.resolve({ data: [], nextCursor: null }),
      batch: () => Promise.resolve([]),
      tags: () => Promise.resolve([]),
      prune: () => Promise.resolve(0),
      clear: () => Promise.resolve(),
    };
    const { recorder: r2 } = makeRecorder({ storage: failingStorage });
    r2.record({ type: 'request', content: {} });
    r2.record({ type: 'request', content: {} });
    await r2.flush(); // drains 2 entries, store rejects → storeFailedDropped += 2
    expect(r2.overflowDropped).toBe(0);
    expect(r2.storeFailedDropped).toBe(2);
    expect(r2.droppedCount).toBe(2);
  });

  it('calls onDrop with reason "overflow" when buffer overflows', () => {
    const onDrop = vi.fn();
    const { recorder } = makeRecorder({ bufferSize: 2, onDrop });
    recorder.record({ type: 'request', content: { n: 1 } });
    recorder.record({ type: 'request', content: { n: 2 } });
    recorder.record({ type: 'request', content: { n: 3 } }); // triggers overflow
    expect(onDrop).toHaveBeenCalledWith(1, 'overflow');
  });

  it('calls onDrop with reason "store-failed" when storage rejects', async () => {
    const onDrop = vi.fn();
    const failingStorage: StorageProvider = {
      store: () => Promise.reject(new Error('boom')),
      update: () => Promise.resolve(),
      find: () => Promise.resolve(null),
      get: () => Promise.resolve({ data: [], nextCursor: null }),
      batch: () => Promise.resolve([]),
      tags: () => Promise.resolve([]),
      prune: () => Promise.resolve(0),
      clear: () => Promise.resolve(),
    };
    const { recorder } = makeRecorder({ storage: failingStorage, onDrop });
    recorder.record({ type: 'request', content: {} });
    await recorder.flush();
    expect(onDrop).toHaveBeenCalledWith(1, 'store-failed');
  });

  it('a faulty onDrop hook does not break the Recorder', async () => {
    const onDrop = () => {
      throw new Error('hook error');
    };
    const { recorder, storage } = makeRecorder({ bufferSize: 1, onDrop });
    // overflow to trigger onDrop
    recorder.record({ type: 'request', content: { n: 1 } });
    recorder.record({ type: 'request', content: { n: 2 } });
    // flush should still work and store the surviving entry
    await expect(recorder.flush()).resolves.toBeUndefined();
    const stored = await storage.get({});
    expect(stored.data).toHaveLength(1);
  });

  it('uses startedAt as createdAt when provided', async () => {
    const explicitDate = new Date('2024-01-15T10:30:00.000Z');
    const { recorder, storage } = makeRecorder({ now: () => 9_999_999 });
    recorder.record({ type: 'request', content: {}, startedAt: explicitDate });
    await recorder.flush();
    const entry = (await storage.get({})).data[0]!;
    expect(entry.createdAt).toEqual(explicitDate);
  });

  it('falls back to now() for createdAt when startedAt is absent', async () => {
    const { recorder, storage } = makeRecorder({ now: () => 1_000 });
    recorder.record({ type: 'request', content: {} });
    await recorder.flush();
    const entry = (await storage.get({})).data[0]!;
    expect(entry.createdAt).toEqual(new Date(1_000));
  });

  // ── Default sampling fallback ─────────────────────────────────────────────

  it('drops an entry of any type when sampling default is 0 and no per-type rate exists', async () => {
    const { recorder, storage } = makeRecorder({
      sampling: { default: 0 },
      random: () => 0.5,
    });
    recorder.record({ type: 'request', content: {} });
    await recorder.flush();
    expect((await storage.get({})).data).toHaveLength(0);
  });

  it('keeps a query entry when per-type rate is 1 even though default is 0', async () => {
    const { recorder, storage } = makeRecorder({
      sampling: { query: 1, default: 0 },
      random: () => 0.5,
    });
    recorder.record({ type: 'query', content: {} });
    await recorder.flush();
    expect((await storage.get({})).data).toHaveLength(1);
  });

  // ── Tail-sampling (per-type rule objects) ─────────────────────────────────

  describe('tail-sampling', () => {
    it('a bare per-type number behaves exactly as before: rate 0 drops, rate 1 keeps', async () => {
      // rate 0 → drop regardless of randomness
      const dropped = makeRecorder({ sampling: { cache: 0 }, random: () => 0 });
      dropped.recorder.record({ type: 'cache', content: { hit: true } });
      await dropped.recorder.flush();
      expect((await dropped.storage.get({})).data).toHaveLength(0);

      // rate 1 → keep regardless of randomness
      const kept = makeRecorder({ sampling: { cache: 1 }, random: () => 0.99 });
      kept.recorder.record({ type: 'cache', content: { hit: true } });
      await kept.recorder.flush();
      expect((await kept.storage.get({})).data).toHaveLength(1);
    });

    it('applies the object rule rate: random under rate keeps, at/over rate drops', async () => {
      // random 0.05 < 0.1 → keep
      const kept = makeRecorder({
        sampling: { cache: { rate: 0.1 } },
        random: () => 0.05,
      });
      kept.recorder.record({ type: 'cache', content: { hit: true } });
      await kept.recorder.flush();
      expect((await kept.storage.get({})).data).toHaveLength(1);

      // random 0.5 ≥ 0.1 → drop
      const dropped = makeRecorder({
        sampling: { cache: { rate: 0.1 } },
        random: () => 0.5,
      });
      dropped.recorder.record({ type: 'cache', content: { hit: true } });
      await dropped.recorder.flush();
      expect((await dropped.storage.get({})).data).toHaveLength(0);
    });

    it('keepErrors keeps a failed entry even at rate 0 (content.failed)', async () => {
      const { recorder, storage } = makeRecorder({
        sampling: { cache: { rate: 0, keepErrors: true } },
        random: () => 0, // would otherwise be dropped at rate 0
      });
      recorder.record({ type: 'cache', content: { failed: true } });
      await recorder.flush();
      expect((await storage.get({})).data).toHaveLength(1);
    });

    it('keepErrors keeps an entry whose content.statusCode >= 500 at rate 0', async () => {
      const { recorder, storage } = makeRecorder({
        sampling: { request: { rate: 0, keepErrors: true } },
        random: () => 0,
      });
      recorder.record({ type: 'request', content: { statusCode: 503 } });
      await recorder.flush();
      expect((await storage.get({})).data).toHaveLength(1);
    });

    it('keepErrors keeps an entry tagged "failed" at rate 0', async () => {
      const { recorder, storage } = makeRecorder({
        sampling: { query: { rate: 0, keepErrors: true } },
        random: () => 0,
      });
      recorder.record({ type: 'query', content: { sql: 'SELECT 1' }, tags: ['failed'] });
      await recorder.flush();
      expect((await storage.get({})).data).toHaveLength(1);
    });

    it('keepSlowMs keeps a slow entry at rate 0 but lets a fast one be sampled out', async () => {
      // slow entry (durationMs >= keepSlowMs) is kept despite rate 0
      const slow = makeRecorder({
        sampling: { cache: { rate: 0, keepSlowMs: 500 } },
        random: () => 0,
      });
      slow.recorder.record({ type: 'cache', content: { hit: true }, durationMs: 750 });
      await slow.recorder.flush();
      expect((await slow.storage.get({})).data).toHaveLength(1);

      // fast & ok entry at rate 0 is dropped
      const fast = makeRecorder({
        sampling: { cache: { rate: 0, keepSlowMs: 500 } },
        random: () => 0,
      });
      fast.recorder.record({ type: 'cache', content: { hit: true }, durationMs: 5 });
      await fast.recorder.flush();
      expect((await fast.storage.get({})).data).toHaveLength(0);
    });

    it('a fast, non-error entry over the rate threshold is sampled out under a rule', async () => {
      const { recorder, storage } = makeRecorder({
        sampling: { cache: { rate: 0.1, keepErrors: true, keepSlowMs: 500 } },
        random: () => 0.9, // over rate, not an error, not slow → drop
      });
      recorder.record({ type: 'cache', content: { hit: true }, durationMs: 10 });
      await recorder.flush();
      expect((await storage.get({})).data).toHaveLength(0);
    });
  });

  // ── Filter hook ───────────────────────────────────────────────────────────

  it('filter hook: stores a request entry but excludes a query entry; droppedCount stays 0 for the excluded one', async () => {
    const { recorder, storage } = makeRecorder({
      filter: (entry) => entry.type !== 'query',
    });

    recorder.record({ type: 'request', content: { path: '/' } });
    recorder.record({ type: 'query', content: { sql: 'SELECT 1' } });
    await recorder.flush();

    const stored = (await storage.get({})).data;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.type).toBe('request');

    // Intentional exclusion must NOT increment any drop counter.
    expect(recorder.droppedCount).toBe(0);
  });

  // ── Self-metrics ──────────────────────────────────────────────────────────

  describe('self-metrics', () => {
    it('reports buffer capacity, used, and high-water as records land and flush', async () => {
      const { recorder } = makeRecorder({ bufferSize: 8 });
      const initial = recorder.getSelfMetrics();
      expect(initial.bufferSize).toBe(8);
      expect(initial.bufferUsed).toBe(0);
      expect(initial.bufferHighWater).toBe(0);
      expect(initial.recorded).toBe(0);

      recorder.record({ type: 'request', content: { n: 1 } });
      recorder.record({ type: 'request', content: { n: 2 } });
      recorder.record({ type: 'request', content: { n: 3 } });

      const afterRecords = recorder.getSelfMetrics();
      expect(afterRecords.recorded).toBe(3);
      expect(afterRecords.bufferUsed).toBe(3);
      expect(afterRecords.bufferHighWater).toBe(3);

      await recorder.flush();
      const afterFlush = recorder.getSelfMetrics();
      // High-water persists even though the ring is now empty.
      expect(afterFlush.bufferUsed).toBe(0);
      expect(afterFlush.bufferHighWater).toBe(3);
      // recorded is cumulative, not reset by flush.
      expect(afterFlush.recorded).toBe(3);
    });

    it('counts a flush and the entries it drained, with deterministic timings', async () => {
      let clock = 1_000;
      const { recorder } = makeRecorder({ now: () => clock });
      recorder.record({ type: 'request', content: {} });
      recorder.record({ type: 'request', content: {} });

      // Advance the clock by 5ms across the flush window.
      const flushPromise = recorder.flush();
      clock = 1_005;
      await flushPromise;

      const metrics = recorder.getSelfMetrics();
      expect(metrics.flushes).toBe(1);
      expect(metrics.flushedEntries).toBe(2);
      expect(metrics.lastFlushMs).toBe(5);
      expect(metrics.maxFlushMs).toBe(5);
      expect(metrics.totalFlushMs).toBe(5);
    });

    it('does not count an empty flush as a flush', async () => {
      const { recorder } = makeRecorder();
      await recorder.flush();
      const metrics = recorder.getSelfMetrics();
      expect(metrics.flushes).toBe(0);
      expect(metrics.flushedEntries).toBe(0);
      expect(metrics.lastFlushMs).toBeNull();
      expect(metrics.maxFlushMs).toBeNull();
      expect(metrics.totalFlushMs).toBe(0);
    });

    it('tracks max flush duration across multiple flushes', async () => {
      let clock = 0;
      const { recorder } = makeRecorder({ now: () => clock });

      recorder.record({ type: 'request', content: {} });
      let flushPromise = recorder.flush();
      clock = 3;
      await flushPromise;

      clock = 100;
      recorder.record({ type: 'request', content: {} });
      flushPromise = recorder.flush();
      clock = 110;
      await flushPromise;

      const metrics = recorder.getSelfMetrics();
      expect(metrics.flushes).toBe(2);
      expect(metrics.lastFlushMs).toBe(10);
      expect(metrics.maxFlushMs).toBe(10);
      expect(metrics.totalFlushMs).toBe(13);
    });

    it('mirrors the drop buckets', async () => {
      const failingStorage: StorageProvider = {
        store: () => Promise.reject(new Error('disk full')),
        update: () => Promise.resolve(),
        find: () => Promise.resolve(null),
        get: () => Promise.resolve({ data: [], nextCursor: null }),
        batch: () => Promise.resolve([]),
        tags: () => Promise.resolve([]),
        prune: () => Promise.resolve(0),
        clear: () => Promise.resolve(),
      };
      const { recorder } = makeRecorder({ storage: failingStorage, bufferSize: 2 });
      recorder.record({ type: 'request', content: {} });
      recorder.record({ type: 'request', content: {} });
      recorder.record({ type: 'request', content: {} }); // overflow → 1
      await recorder.flush(); // store rejects → storeFailedDropped += 2

      const metrics = recorder.getSelfMetrics();
      expect(metrics.overflowDropped).toBe(1);
      expect(metrics.storeFailedDropped).toBe(2);
      expect(metrics.droppedCount).toBe(3);
    });

    it('benchmarkRecordCost returns a positive mean and does not enqueue', () => {
      const { recorder } = makeRecorder();
      const meanNanos = recorder.benchmarkRecordCost(100);
      expect(meanNanos).toBeGreaterThan(0);
      // The benchmark must not pollute the live buffer.
      expect(recorder.getSelfMetrics().recorded).toBe(0);
      expect(recorder.getSelfMetrics().bufferUsed).toBe(0);
    });

    it('benchmarkRecordCost returns 0 for non-positive iterations', () => {
      const { recorder } = makeRecorder();
      expect(recorder.benchmarkRecordCost(0)).toBe(0);
      expect(recorder.benchmarkRecordCost(-5)).toBe(0);
    });

    it('counts entries whose content was truncated by a redaction bound', async () => {
      const { recorder } = makeRecorder();
      // A normal entry: nothing truncated.
      recorder.record({ type: 'request', content: { ok: 1 } });
      expect(recorder.getSelfMetrics().truncatedCount).toBe(0);

      // A fat entry whose string field blows past the default maxStringLength.
      recorder.record({ type: 'request', content: { blob: 'x'.repeat(20_000) } });
      expect(recorder.getSelfMetrics().truncatedCount).toBe(1);

      // A second fat entry increments again.
      recorder.record({ type: 'request', content: { blob: 'y'.repeat(20_000) } });
      expect(recorder.getSelfMetrics().truncatedCount).toBe(2);

      await recorder.flush();
      // Cumulative — not reset by flush.
      expect(recorder.getSelfMetrics().truncatedCount).toBe(2);
    });
  });

  // ── Ring-buffer slot hygiene (incident fix) ────────────────────────────────

  describe('drain slot hygiene', () => {
    it('nulls drained slots so fat entries do not linger in the ring after a flush', async () => {
      const { recorder } = makeRecorder({ bufferSize: 4 });
      recorder.record({ type: 'request', content: { n: 1 } });
      recorder.record({ type: 'request', content: { n: 2 } });
      recorder.record({ type: 'request', content: { n: 3 } });
      // Before the flush, three slots hold entries.
      expect(recorder.retainedSlotCount).toBe(3);

      await recorder.flush();

      // After the flush the ring retains nothing — no stale references linger.
      expect(recorder.retainedSlotCount).toBe(0);
      expect(recorder.getSelfMetrics().bufferUsed).toBe(0);
    });

    it('keeps retainedSlotCount equal to live entries across interleaved record/flush', async () => {
      const { recorder } = makeRecorder({ bufferSize: 4 });
      recorder.record({ type: 'request', content: { n: 1 } });
      recorder.record({ type: 'request', content: { n: 2 } });
      await recorder.flush();
      // New records after a flush reuse the (now-nulled) slots cleanly.
      recorder.record({ type: 'request', content: { n: 3 } });
      expect(recorder.retainedSlotCount).toBe(1);
      expect(recorder.getSelfMetrics().bufferUsed).toBe(1);
    });
  });

  // ── Trace context enrichment ──────────────────────────────────────────────

  describe('trace context enrichment', () => {
    it('stamps traceId/spanId from the provider when current() returns a context', async () => {
      const traceId = 'a'.repeat(32);
      const spanId = 'b'.repeat(16);
      const { recorder, storage } = makeRecorder({
        traceContext: { current: () => ({ traceId, spanId }) },
      });
      recorder.record({ type: 'request', content: {} });
      await recorder.flush();
      const entry = (await storage.get({})).data[0]!;
      expect(entry.traceId).toBe(traceId);
      expect(entry.spanId).toBe(spanId);
    });

    it('stamps null/null when no provider is configured', async () => {
      const { recorder, storage } = makeRecorder();
      recorder.record({ type: 'request', content: {} });
      await recorder.flush();
      const entry = (await storage.get({})).data[0]!;
      expect(entry.traceId).toBeNull();
      expect(entry.spanId).toBeNull();
    });

    it('stamps null/null when current() returns null', async () => {
      const { recorder, storage } = makeRecorder({
        traceContext: { current: () => null },
      });
      recorder.record({ type: 'request', content: {} });
      await recorder.flush();
      const entry = (await storage.get({})).data[0]!;
      expect(entry.traceId).toBeNull();
      expect(entry.spanId).toBeNull();
    });

    it('records the entry with null ids when current() throws (defensive read)', async () => {
      const { recorder, storage } = makeRecorder({
        traceContext: {
          current: () => {
            throw new Error('provider exploded');
          },
        },
      });
      recorder.record({ type: 'request', content: {} });
      await recorder.flush();
      const stored = (await storage.get({})).data;
      // The enrich-level try/catch keeps the entry instead of dropping it.
      expect(stored).toHaveLength(1);
      expect(stored[0]!.traceId).toBeNull();
      expect(stored[0]!.spanId).toBeNull();
    });
  });
});
