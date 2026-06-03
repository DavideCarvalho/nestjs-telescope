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
