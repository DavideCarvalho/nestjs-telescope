import { describe, expect, it } from 'vitest';
import { TelescopeContext } from '../context/telescope-context.js';
import type { Entry } from '../entry/entry.js';
import type { RollupBucket } from '../rollup/rollup-store.js';
import { emptyHistogram, floorToBucket, incrementHistogram } from '../rollup/rollup-store.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { Recorder } from './recorder.js';

function makeRecorder(storage: StorageProvider, nowMs: number): Recorder {
  let counter = 0;
  return new Recorder({
    storage,
    context: new TelescopeContext(),
    instanceId: 'pod-1',
    taggers: [],
    redact: {},
    sampling: {},
    bufferSize: 100,
    now: () => nowMs,
    random: () => 0,
    idFactory: () => `id-${counter++}`,
  });
}

describe('Recorder rollup aggregation', () => {
  it('records rollups reflecting the flushed entries (count/sum/max per type/bucket)', async () => {
    const nowMs = floorToBucket(1_700_000_000_000) + 10_000;
    const storage = new InMemoryStorageProvider();
    const recorder = makeRecorder(storage, nowMs);

    recorder.record({ type: 'request', content: {}, durationMs: 10 });
    recorder.record({ type: 'request', content: {}, durationMs: 30 });
    recorder.record({ type: 'request', content: {}, durationMs: null }); // null → 0
    recorder.record({ type: 'query', content: {}, durationMs: 5 });
    await recorder.flush();

    const bucket = floorToBucket(nowMs);
    const rollups = await storage.queryRollups(['request', 'query'], bucket, bucket);
    const byMetric = new Map(rollups.map((r) => [r.metric, r]));

    const requestHistogram = emptyHistogram();
    incrementHistogram(requestHistogram, 10);
    incrementHistogram(requestHistogram, 30);
    // null duration contributes to count/sum/max but NOT the histogram.
    expect(byMetric.get('request')).toEqual({
      metric: 'request',
      bucketStart: bucket,
      count: 3,
      sum: 40,
      max: 30,
      histogram: requestHistogram,
    });
    const queryHistogram = emptyHistogram();
    incrementHistogram(queryHistogram, 5);
    expect(byMetric.get('query')).toEqual({
      metric: 'query',
      bucketStart: bucket,
      count: 1,
      sum: 5,
      max: 5,
      histogram: queryHistogram,
    });
  });

  it('flushing to a NON-rollup storage still works (no error, entries stored)', async () => {
    const stored: Entry[] = [];
    const storage: StorageProvider = {
      store: (entries: Entry[]): Promise<void> => {
        stored.push(...entries);
        return Promise.resolve();
      },
      update: () => Promise.resolve(),
      find: () => Promise.resolve(null),
      get: () => Promise.resolve({ data: [], nextCursor: null }),
      batch: () => Promise.resolve([]),
      tags: () => Promise.resolve([]),
      prune: () => Promise.resolve(0),
      clear: () => Promise.resolve(),
    };
    const recorder = makeRecorder(storage, Date.now());
    recorder.record({ type: 'request', content: {} });
    await expect(recorder.flush()).resolves.toBeUndefined();
    expect(stored).toHaveLength(1);
  });

  it('swallows a rollup failure without counting it as a store-failed drop', async () => {
    const stored: Entry[] = [];
    const storage: StorageProvider & {
      recordRollups: () => Promise<void>;
      queryRollups: () => Promise<RollupBucket[]>;
    } = {
      store: (entries: Entry[]): Promise<void> => {
        stored.push(...entries);
        return Promise.resolve();
      },
      update: () => Promise.resolve(),
      find: () => Promise.resolve(null),
      get: () => Promise.resolve({ data: [], nextCursor: null }),
      batch: () => Promise.resolve([]),
      tags: () => Promise.resolve([]),
      prune: () => Promise.resolve(0),
      clear: () => Promise.resolve(),
      recordRollups: () => Promise.reject(new Error('rollup exploded')),
      queryRollups: () => Promise.resolve([]),
    };
    const recorder = makeRecorder(storage, Date.now());
    recorder.record({ type: 'request', content: {} });
    await recorder.flush();
    // Entry stored; the rollup failure did not inflate the store-failed counter.
    expect(stored).toHaveLength(1);
    expect(recorder.storeFailedDropped).toBe(0);
    expect(recorder.droppedCount).toBe(0);
  });
});
