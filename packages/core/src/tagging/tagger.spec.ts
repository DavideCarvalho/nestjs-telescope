// packages/core/src/tagging/tagger.spec.ts
import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { runTaggers, slowTagger, statusTagger } from './tagger.js';

function entry(over: Partial<Entry>): Entry {
  return {
    id: 'id',
    batchId: 'b',
    type: 'request',
    familyHash: null,
    content: {},
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'i',
    createdAt: new Date(),
    ...over,
  };
}

describe('taggers', () => {
  it('statusTagger tags request entries with their status code', () => {
    const tags = statusTagger(entry({ type: 'request', content: { statusCode: 500 } }));
    expect(tags).toEqual(['status:500']);
  });

  it('statusTagger ignores non-request entries even if content has a statusCode', () => {
    expect(statusTagger(entry({ type: 'query', content: { statusCode: 200 } }))).toEqual([]);
  });

  it('slowTagger flags entries over the threshold (inclusive boundary)', () => {
    expect(slowTagger(entry({ durationMs: 1500 }))).toEqual(['slow']);
    expect(slowTagger(entry({ durationMs: 1000 }))).toEqual(['slow']);
    expect(slowTagger(entry({ durationMs: 999 }))).toEqual([]);
    expect(slowTagger(entry({ durationMs: 5 }))).toEqual([]);
  });

  it('runTaggers concatenates and de-duplicates tags onto existing ones', () => {
    const result = runTaggers(
      entry({ tags: ['keep'], durationMs: 2000, content: { statusCode: 500 } }),
      [statusTagger, slowTagger, () => ['keep']],
    );
    expect(result).toEqual(['keep', 'status:500', 'slow']);
  });
});
