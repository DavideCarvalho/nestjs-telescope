import { describe, expect, it } from 'vitest';
import { buildTableQuery } from './table-query.js';

describe('buildTableQuery', () => {
  it('returns the panel query by identity when nothing is paged, sorted or filtered', () => {
    // Identity, not equality: the query is part of the React Query cache key, so
    // a plain table has to produce the very same query it produced before this
    // feature existed or every existing dashboard starts on a cold cache entry.
    const base = { window: '24h' };
    expect(buildTableQuery(base, { filters: {} })).toBe(base);
    expect(buildTableQuery(undefined, {})).toBeUndefined();
  });

  it('merges paging the way the pager already did', () => {
    expect(buildTableQuery({ window: '24h' }, { paging: { page: 2, limit: 50 } })).toEqual({
      window: '24h',
      page: 2,
      limit: 50,
    });
  });

  it('sends a sort as `sort` + `dir`', () => {
    expect(buildTableQuery(undefined, { sort: { key: 'duration', dir: 'desc' } })).toEqual({
      sort: 'duration',
      dir: 'desc',
    });
  });

  it("namespaces filters so they cannot collide with the panel's own query keys", () => {
    // A panel scoped to running rows AND a filterable `status` column is an
    // ordinary combination; unprefixed, one would silently overwrite the other.
    expect(buildTableQuery({ status: 'running' }, { filters: { status: 'failed' } })).toEqual({
      status: 'running',
      'filter.status': 'failed',
    });
  });

  it('drops an emptied filter instead of sending an empty string', () => {
    // A cleared box means "no filter". Sent through, a provider that treats the
    // value literally returns zero rows and the table reads as broken.
    const base = { window: '24h' };
    expect(buildTableQuery(base, { filters: { status: '' } })).toBe(base);
  });

  it('carries paging, sort and filters together', () => {
    expect(
      buildTableQuery(
        { window: '24h' },
        {
          paging: { page: 3, limit: 50 },
          sort: { key: 'startedAt', dir: 'asc' },
          filters: { workflow: 'checkout' },
        },
      ),
    ).toEqual({
      window: '24h',
      page: 3,
      limit: 50,
      sort: 'startedAt',
      dir: 'asc',
      'filter.workflow': 'checkout',
    });
  });
});
