// packages/core/src/recorder/recorder.spec.ts
import { describe, expect, it } from 'vitest';
import { TelescopeContext } from '../context/telescope-context.js';
import { createBatch } from '../context/batch.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
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

describe('Recorder', () => {
  it('enriches an input into an entry with batch id, sequence, instance id', async () => {
    const { recorder, storage, context } = makeRecorder();
    await context.run(createBatch('http', () => 'batch-1', () => 1_000), async () => {
      recorder.record({ type: 'request', content: { statusCode: 200 } });
    });
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
});
