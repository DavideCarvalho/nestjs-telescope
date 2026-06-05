// packages/core/src/tagging/tagger.spec.ts
import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { BUILTIN_TAGGERS, runTaggers, slowTagger, statusTagger, userTagger } from './tagger.js';

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
    traceId: null,
    spanId: null,
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

  it('userTagger tags a request with content.user.id', () => {
    expect(userTagger(entry({ type: 'request', content: { user: { id: 42 } } }))).toEqual([
      'user:42',
    ]);
    expect(userTagger(entry({ type: 'request', content: { user: { id: 'u-1' } } }))).toEqual([
      'user:u-1',
    ]);
  });

  it('userTagger falls back to _id, then email, in that order', () => {
    expect(userTagger(entry({ type: 'request', content: { user: { _id: 'abc' } } }))).toEqual([
      'user:abc',
    ]);
    expect(userTagger(entry({ type: 'request', content: { user: { email: 'a@b.com' } } }))).toEqual(
      ['user:a@b.com'],
    );
    // id wins over _id wins over email
    expect(
      userTagger(
        entry({ type: 'request', content: { user: { id: 'x', _id: 'y', email: 'z@b.com' } } }),
      ),
    ).toEqual(['user:x']);
    expect(
      userTagger(entry({ type: 'request', content: { user: { _id: 'y', email: 'z@b.com' } } })),
    ).toEqual(['user:y']);
  });

  it('userTagger never tags a non-request entry, even with a user', () => {
    expect(userTagger(entry({ type: 'query', content: { user: { id: 7 } } }))).toEqual([]);
    expect(userTagger(entry({ type: 'job', content: { user: { id: 7 } } }))).toEqual([]);
  });

  it('userTagger yields no tag for a request without a usable user identity', () => {
    expect(userTagger(entry({ type: 'request', content: {} }))).toEqual([]);
    expect(userTagger(entry({ type: 'request', content: { user: null } }))).toEqual([]);
    expect(userTagger(entry({ type: 'request', content: { user: {} } }))).toEqual([]);
    // empty string id / non-finite number are not usable identities
    expect(userTagger(entry({ type: 'request', content: { user: { id: '' } } }))).toEqual([]);
    expect(userTagger(entry({ type: 'request', content: { user: { id: Number.NaN } } }))).toEqual(
      [],
    );
  });

  it('userTagger never throws on weird content shapes', () => {
    expect(() => userTagger(entry({ type: 'request', content: null }))).not.toThrow();
    expect(() => userTagger(entry({ type: 'request', content: 'a string' }))).not.toThrow();
    expect(() => userTagger(entry({ type: 'request', content: 42 }))).not.toThrow();
    expect(() => userTagger(entry({ type: 'request', content: [1, 2, 3] }))).not.toThrow();
    expect(() =>
      userTagger(entry({ type: 'request', content: { user: 'not-an-object' } })),
    ).not.toThrow();
    expect(userTagger(entry({ type: 'request', content: { user: ['array'] } }))).toEqual([]);
  });

  it('userTagger is registered as a builtin tagger', () => {
    expect(BUILTIN_TAGGERS).toContain(userTagger);
  });

  it('runTaggers concatenates and de-duplicates tags onto existing ones', () => {
    const result = runTaggers(
      entry({ tags: ['keep'], durationMs: 2000, content: { statusCode: 500 } }),
      [statusTagger, slowTagger, () => ['keep']],
    );
    expect(result).toEqual(['keep', 'status:500', 'slow']);
  });
});
