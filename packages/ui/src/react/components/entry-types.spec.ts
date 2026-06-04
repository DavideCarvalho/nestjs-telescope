import { describe, expect, it } from 'vitest';
import { ENTRY_TYPES, dotForType, labelForType, resolveEntryQuery } from './entry-types.js';

describe('ENTRY_TYPES dump', () => {
  it('includes a dump type with a label and dot color', () => {
    const dump = ENTRY_TYPES.find((type) => type.id === 'dump');
    expect(dump).toEqual({ id: 'dump', label: 'Dumps', dot: 'bg-fuchsia-400' });
    expect(labelForType('dump')).toBe('Dumps');
    expect(dotForType('dump')).toBe('bg-fuchsia-400');
  });
});

describe('ENTRY_TYPES model and redis', () => {
  it('includes a model type with a label and dot color', () => {
    const model = ENTRY_TYPES.find((type) => type.id === 'model');
    expect(model).toEqual({ id: 'model', label: 'Models', dot: 'bg-lime-400' });
    expect(labelForType('model')).toBe('Models');
    expect(dotForType('model')).toBe('bg-lime-400');
  });

  it('includes a redis type with a label and dot color', () => {
    const redis = ENTRY_TYPES.find((type) => type.id === 'redis');
    expect(redis).toEqual({ id: 'redis', label: 'Redis', dot: 'bg-rose-400' });
    expect(labelForType('redis')).toBe('Redis');
    expect(dotForType('redis')).toBe('bg-rose-400');
  });
});

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
