import { describe, expect, it } from 'vitest';
import { resolveEntryQuery } from './entry-types.js';

describe('resolveEntryQuery', () => {
  it('maps schedule onto the tagged-job filter', () => {
    expect(resolveEntryQuery('schedule')).toEqual({ type: 'job', tag: 'schedule' });
  });

  it('passes a plain type through unchanged', () => {
    expect(resolveEntryQuery('query')).toEqual({ type: 'query' });
  });

  it('falls back to { type: id } for unknown ids', () => {
    expect(resolveEntryQuery('mystery')).toEqual({ type: 'mystery' });
  });
});
