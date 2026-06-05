import { describe, expect, it } from 'vitest';
import {
  ENTRY_TYPES,
  dotForType,
  labelForType,
  resolveEntryQuery,
  visibleEntryTypes,
  visibleTypeTabIds,
} from './entry-types.js';

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

describe('visibleEntryTypes', () => {
  it('shows everything when the watcher list is undefined (meta not loaded / old server)', () => {
    expect(visibleEntryTypes(ENTRY_TYPES, undefined)).toEqual(ENTRY_TYPES);
  });

  it('hides types whose watcher meta says is absent, keeping canonical order', () => {
    const visible = visibleEntryTypes(ENTRY_TYPES, ['request', 'exception', 'query', 'redis']);
    expect(visible.map((type) => type.id)).toEqual(['request', 'query', 'exception', 'redis']);
  });

  it('always shows request and exception even if the watcher list omits them', () => {
    // an empty watcher list should still leave the unconditional core types
    const visible = visibleEntryTypes(ENTRY_TYPES, []);
    expect(visible.map((type) => type.id)).toEqual(['request', 'exception']);
  });

  it('shows schedule whenever the job watcher is registered (it rides on job)', () => {
    const visible = visibleEntryTypes(ENTRY_TYPES, ['job']);
    expect(visible.map((type) => type.id)).toContain('schedule');
    expect(visible.map((type) => type.id)).toContain('job');
  });

  it('hides schedule when job is not registered', () => {
    const visible = visibleEntryTypes(ENTRY_TYPES, ['request', 'exception']);
    expect(visible.map((type) => type.id)).not.toContain('schedule');
  });
});

describe('visibleTypeTabIds', () => {
  it('prepends the all tab to the visible type ids', () => {
    expect(visibleTypeTabIds(['query'])).toEqual(['all', 'request', 'query', 'exception']);
  });

  it('shows all tabs (all + every type) when watchers is undefined', () => {
    expect(visibleTypeTabIds(undefined)).toEqual(['all', ...ENTRY_TYPES.map((type) => type.id)]);
  });
});
