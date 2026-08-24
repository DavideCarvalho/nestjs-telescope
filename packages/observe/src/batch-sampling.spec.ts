import type { Entry } from '@dudousxd/nestjs-telescope';
import { describe, expect, it } from 'vitest';
import type { AssembledBatch } from './assemble/assembled-batch.js';
import { batchHasFailure, batchToUnitInterval, shouldExportBatch } from './batch-sampling.js';

function entry(type: string, content: unknown, overrides: Partial<Entry> = {}): Entry {
  return {
    id: `e-${type}`,
    batchId: 'batch-1',
    type,
    familyHash: null,
    content,
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'i1',
    traceId: null,
    spanId: null,
    createdAt: new Date(0),
    ...overrides,
  } as Entry;
}

function batch(root: Entry | null, children: Entry[] = [], batchId = 'batch-1'): AssembledBatch {
  return { batchId, origin: 'http', root, children };
}

const okRequest = entry('request', { method: 'GET', uri: '/', statusCode: 200 });

describe('batchToUnitInterval', () => {
  it('is deterministic for the same batch id', () => {
    expect(batchToUnitInterval('abc')).toBe(batchToUnitInterval('abc'));
  });

  it('stays inside [0, 1)', () => {
    for (const id of ['', 'a', 'batch-1', '0198f0c2-9a3b-7000-8000-000000000000', '🙂']) {
      const value = batchToUnitInterval(id);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('spreads ids across the interval rather than clustering', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `batch-${i}`);
    const kept = ids.filter((id) => batchToUnitInterval(id) < 0.25).length;
    expect(kept / ids.length).toBeGreaterThan(0.2);
    expect(kept / ids.length).toBeLessThan(0.3);
  });
});

describe('batchHasFailure', () => {
  it('is false for a clean request batch', () => {
    expect(batchHasFailure(batch(okRequest, [entry('query', { sql: 'select 1' })]))).toBe(false);
  });

  it('is true for a 5xx root', () => {
    const root = entry('request', { method: 'GET', uri: '/', statusCode: 503 });
    expect(batchHasFailure(batch(root))).toBe(true);
  });

  it('is true for an exception child', () => {
    const boom = entry('exception', { class: 'Error', message: 'boom' }, { tags: ['failed'] });
    expect(batchHasFailure(batch(okRequest, [boom]))).toBe(true);
  });

  it('is true for an error-level log child', () => {
    const log = entry('log', { level: 'error', message: 'bad', context: null });
    expect(batchHasFailure(batch(okRequest, [log]))).toBe(true);
  });

  it('is false for an info-level log child', () => {
    const log = entry('log', { level: 'log', message: 'fine', context: null });
    expect(batchHasFailure(batch(okRequest, [log]))).toBe(false);
  });

  it('is true for a rootless batch whose child failed', () => {
    const boom = entry('exception', { class: 'Error', message: 'boom' }, { tags: ['failed'] });
    expect(batchHasFailure(batch(null, [boom]))).toBe(true);
  });
});

describe('shouldExportBatch', () => {
  it('keeps everything at rate 1', () => {
    expect(shouldExportBatch(batch(okRequest), 1)).toBe(true);
  });

  it('drops a clean batch at rate 0', () => {
    expect(shouldExportBatch(batch(okRequest), 0)).toBe(false);
  });

  it('keeps a failing batch even at rate 0', () => {
    const boom = entry('exception', { class: 'Error', message: 'boom' }, { tags: ['failed'] });
    expect(shouldExportBatch(batch(okRequest, [boom]), 0)).toBe(true);
  });

  it('decides from the batch id, so every entry of one batch agrees', () => {
    // The same batch assembled twice — as it is when late entries reopen it —
    // must reach the same verdict, or a request ships without half its spans.
    const first = batch(okRequest, [entry('query', { sql: 'select 1' })], 'batch-xyz');
    const second = batch(null, [entry('cache', { operation: 'get', key: 'k' })], 'batch-xyz');
    expect(shouldExportBatch(first, 0.5)).toBe(shouldExportBatch(second, 0.5));
  });

  it('approximates the requested rate over many batches', () => {
    const batches = Array.from({ length: 2000 }, (_, i) => batch(okRequest, [], `b-${i}`));
    const kept = batches.filter((b) => shouldExportBatch(b, 0.1)).length;
    expect(kept / batches.length).toBeGreaterThan(0.07);
    expect(kept / batches.length).toBeLessThan(0.13);
  });
});
