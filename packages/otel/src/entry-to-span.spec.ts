import { describe, expect, it } from 'vitest';
import { entryToSpan } from './entry-to-span.js';
import type { Entry } from '@dudousxd/nestjs-telescope';

function entry(over: Partial<Entry>): Entry {
  return {
    id: 'e1', batchId: 'b1', type: 'request', familyHash: null, content: {},
    tags: [], sequence: 0, durationMs: 20, origin: 'http', instanceId: 'pod-1',
    traceId: 'abc', spanId: 'def', createdAt: new Date(1_000), ...over,
  } as Entry;
}

describe('entryToSpan', () => {
  it('names the span by type and spans [createdAt, createdAt+durationMs]', () => {
    const s = entryToSpan(entry({ type: 'query', durationMs: 5, createdAt: new Date(1_000) }));
    expect(s.name).toBe('telescope.query');
    expect(s.startMs).toBe(1_000);
    expect(s.endMs).toBe(1_005);
    expect(s.attributes['telescope.type']).toBe('query');
    expect(s.traceId).toBe('abc');
  });

  it('treats a null duration as a zero-length span', () => {
    const s = entryToSpan(entry({ durationMs: null, createdAt: new Date(2_000) }));
    expect(s.endMs).toBe(2_000);
  });
});
