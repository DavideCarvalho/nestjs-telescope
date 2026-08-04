import { describe, expect, it } from 'vitest';
import { TABLE_FILTER_PREFIX, readTableQuery } from './table-query.js';

/**
 * `readTableQuery` is the whole reason the table SPI is safe to hand to sibling
 * libraries: every value it reads has already been through a URL, so it is a
 * string, and the interesting cases are all "the provider would have believed
 * something false" rather than "the provider crashed".
 */
describe('readTableQuery', () => {
  it('reads the shape the UI actually sends over the wire (all strings)', () => {
    expect(
      readTableQuery({
        page: '2',
        limit: '50',
        sort: 'duration',
        dir: 'desc',
        'filter.status': 'failed',
      }),
    ).toEqual({
      page: 2,
      limit: 50,
      sort: { key: 'duration', dir: 'desc' },
      filters: { status: 'failed' },
    });
  });

  it('reads the same query built with real numbers, so unit tests and HTTP agree', () => {
    // A provider tested with `{ page: 2 }` and served `?page=2` must not behave
    // differently — that difference is invisible until production.
    expect(readTableQuery({ page: 2, limit: 50 })).toEqual({ page: 2, limit: 50, filters: {} });
  });

  it('returns an empty request for a provider called with no query at all', () => {
    expect(readTableQuery(undefined)).toEqual({ filters: {} });
    expect(readTableQuery({})).toEqual({ filters: {} });
  });

  it("leaves a panel's own static query keys alone", () => {
    // `data.query` is opaque to the table contract; only the reserved keys and
    // the `filter.` namespace are claimed.
    expect(readTableQuery({ window: '24h', workflow: 'checkout' })).toEqual({ filters: {} });
  });

  it('does not confuse a static `status` scope with a `status` column filter', () => {
    // The exact collision the `filter.` prefix exists to prevent: a panel scoped
    // to running rows AND a filterable status column. Unprefixed, one would
    // overwrite the other with no way to tell from the provider's side.
    const query = readTableQuery({ status: 'running', 'filter.status': 'failed' });
    expect(query.filters).toEqual({ status: 'failed' });
  });

  it('drops an emptied filter box rather than filtering on the empty string', () => {
    // Clearing the box sends `filter.status=`; treating that as "match empty"
    // would return zero rows and read as a broken table.
    expect(readTableQuery({ 'filter.status': '' }).filters).toEqual({});
  });

  it('ignores a bare `filter.` with no column name', () => {
    expect(readTableQuery({ [TABLE_FILTER_PREFIX]: 'x' }).filters).toEqual({});
  });

  it('degrades a junk page to absent rather than handing a provider NaN', () => {
    // `Number('banana')` is NaN, and NaN reaching an OFFSET is a 500 the panel
    // author never wrote.
    for (const page of ['banana', '0', '-1', '1.5', '']) {
      expect(readTableQuery({ page }).page).toBeUndefined();
    }
  });

  it('reads an unrecognised direction as ascending instead of passing it through', () => {
    expect(readTableQuery({ sort: 'name', dir: 'sideways' }).sort).toEqual({
      key: 'name',
      dir: 'asc',
    });
    expect(readTableQuery({ sort: 'name' }).sort).toEqual({ key: 'name', dir: 'asc' });
  });

  it('ignores a direction with no column — there is nothing to sort', () => {
    expect(readTableQuery({ dir: 'desc' }).sort).toBeUndefined();
    expect(readTableQuery({ sort: '', dir: 'desc' }).sort).toBeUndefined();
  });
});
