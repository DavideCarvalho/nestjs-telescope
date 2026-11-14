/**
 * Tests for the shared Aviary list API helpers. Copy VERBATIM next to `list-api.ts` (canonical
 * source: ~/personal/oss/nestjs/_shared/list-api/). Needs only vitest and `@nestjs/common`.
 */
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  ListQueryError,
  cursorPage,
  offsetPage,
  parseCursorParams,
  parseFilterParams,
  parsePageParams,
  resolveSort,
} from './list-api.js';

function expect400(fn: () => unknown): ListQueryError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ListQueryError);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as ListQueryError).getStatus()).toBe(400);
    return error as ListQueryError;
  }
  throw new Error('expected a ListQueryError');
}

/** A cursor codec of the kind a store would use: base64url JSON, `null` when malformed. */
const encode = (values: unknown[]): string =>
  Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
const decode = (cursor: string): unknown[] | null => {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

describe('parsePageParams', () => {
  it('defaults to page 1 and the default size', () => {
    expect(parsePageParams({})).toEqual({ page: 1, size: 25, offset: 0 });
    expect(parsePageParams({}, { defaultSize: 50 })).toEqual({ page: 1, size: 50, offset: 0 });
  });

  it('reads page and size, treating empty values as absent', () => {
    expect(parsePageParams({ page: '3', size: '20' })).toEqual({ page: 3, size: 20, offset: 40 });
    expect(parsePageParams({ page: '', size: '' })).toEqual({ page: 1, size: 25, offset: 0 });
  });

  it('clamps size over the cap', () => {
    expect(parsePageParams({ size: '500' }, { maxSize: 200 }).size).toBe(200);
    expect(parsePageParams({}, { defaultSize: 500, maxSize: 200 }).size).toBe(200);
  });

  it.each([
    ['page', 'abc'],
    ['page', '0'],
    ['page', '-2'],
    ['page', '1.5'],
    ['page', ['1', '2']],
    ['size', '0'],
    ['size', 'ten'],
  ])('rejects %s=%j with a 400', (key, value) => {
    expect(expect400(() => parsePageParams({ [key]: value })).message).toContain(`"${key}"`);
  });
});

describe('parseCursorParams', () => {
  it('defaults to a forward first page', () => {
    expect(parseCursorParams({})).toEqual({ size: 25, backward: false });
  });

  it('reads after + first and before + last, clamping to the cap', () => {
    expect(parseCursorParams({ after: 'c1', first: '10' })).toEqual({
      after: 'c1',
      size: 10,
      backward: false,
    });
    expect(parseCursorParams({ before: 'c0', last: '5' })).toEqual({
      before: 'c0',
      size: 5,
      backward: true,
    });
    expect(parseCursorParams({ first: '1000' }, { maxSize: 50 }).size).toBe(50);
  });

  it('rejects both cursors, bad sizes and malformed cursors with a 400', () => {
    expect400(() => parseCursorParams({ after: 'a', before: 'b' }));
    expect400(() => parseCursorParams({ first: '0' }));
    expect400(() => parseCursorParams({ after: ['a', 'b'] }));
    expect400(() => parseCursorParams({ after: 'garbage' }, { decode }));
  });

  it('round-trips a cursor through the response envelope', () => {
    const response = cursorPage([{ id: 1 }, { id: 2 }], { nextCursor: encode([2]) });
    const wire = JSON.parse(JSON.stringify(response)) as typeof response;
    const after = wire.meta.nextCursor ?? '';
    const next = parseCursorParams({ after, first: '2' }, { decode });
    expect(next).toEqual({ after: wire.meta.nextCursor, size: 2, backward: false, decoded: [2] });
  });
});

describe('resolveSort', () => {
  const sortable = ['createdAt', 'name'] as const;

  it('parses the - prefix and repeated params', () => {
    expect(resolveSort('-createdAt,name', { sortable })).toEqual([
      { field: 'createdAt', direction: 'desc' },
      { field: 'name', direction: 'asc' },
    ]);
    expect(resolveSort(['-name'], { sortable })).toEqual([{ field: 'name', direction: 'desc' }]);
  });

  it('returns the default when no sort is sent', () => {
    expect(resolveSort(undefined, { sortable, default: '-createdAt' })).toEqual([
      { field: 'createdAt', direction: 'desc' },
    ]);
    expect(resolveSort('', { sortable })).toEqual([]);
  });

  it('rejects a field outside the allow-list with a 400', () => {
    expect(expect400(() => resolveSort('secret', { sortable })).message).toContain('secret');
  });
});

describe('envelopes', () => {
  it('offsetPage', () => {
    expect(offsetPage(['a'], { total: 120, page: 2, size: 50 })).toEqual({
      data: ['a'],
      meta: { total: 120, perPage: 50, currentPage: 2, lastPage: 3, firstPage: 1 },
    });
    expect(offsetPage([], { total: 0, page: 1, size: 25 }).meta.lastPage).toBe(1);
  });

  it('cursorPage', () => {
    expect(cursorPage(['a'], { nextCursor: 'n' })).toEqual({
      data: ['a'],
      meta: { nextCursor: 'n', prevCursor: null, hasNext: true, hasPrev: false },
    });
  });
});

describe('parseFilterParams', () => {
  const fields = {
    status: ['eq', 'in'],
    createdAt: ['gte', 'lte'],
    id: ['in', 'notIn'],
    deletedAt: ['isNull'],
  } as const;

  it('reads the Express-parsed nested form', () => {
    const query = {
      filter: {
        status: 'open',
        createdAt: { gte: '2026-01-01', lte: '2026-02-01' },
        id: { notIn: '1,2' },
        deletedAt: { isNull: 'true' },
      },
    };
    expect(parseFilterParams(query, { fields })).toEqual([
      { field: 'status', op: 'eq', value: 'open' },
      { field: 'createdAt', op: 'gte', value: '2026-01-01' },
      { field: 'createdAt', op: 'lte', value: '2026-02-01' },
      { field: 'id', op: 'notIn', value: ['1', '2'] },
      { field: 'deletedAt', op: 'isNull', value: 'true' },
    ]);
  });

  it('reads lists: comma, [] and repeated', () => {
    expect(parseFilterParams({ filter: { status: 'open,closed' } }, { fields })).toEqual([
      { field: 'status', op: 'in', value: ['open', 'closed'] },
    ]);
    expect(parseFilterParams({ filter: { status: ['open', 'closed'] } }, { fields })).toEqual([
      { field: 'status', op: 'in', value: ['open', 'closed'] },
    ]);
    expect(parseFilterParams({ filter: { id: { in: ['1', '2'] } } }, { fields })).toEqual([
      { field: 'id', op: 'in', value: ['1', '2'] },
    ]);
  });

  it('reads flat bracket keys', () => {
    const query = {
      'filter[status]': 'open',
      'filter[createdAt][gte]': '2026-01-01',
      'filter[id][]': ['1', '2'],
      'filter[id][notIn]': '3,4',
      page: '1',
    };
    expect(parseFilterParams(query, { fields })).toEqual([
      { field: 'status', op: 'eq', value: 'open' },
      { field: 'createdAt', op: 'gte', value: '2026-01-01' },
      { field: 'id', op: 'in', value: ['1', '2'] },
      { field: 'id', op: 'notIn', value: ['3', '4'] },
    ]);
    expect(parseFilterParams({ 'filter[id][]': '7' }, { fields })).toEqual([
      { field: 'id', op: 'in', value: ['7'] },
    ]);
  });

  it('skips an empty bare value and returns [] with no filter', () => {
    expect(parseFilterParams({ filter: { status: '' } }, { fields })).toEqual([]);
    expect(parseFilterParams({}, { fields })).toEqual([]);
  });

  it('rejects unknown fields and operators with a 400', () => {
    expect(
      expect400(() => parseFilterParams({ filter: { secret: 'x' } }, { fields })).message,
    ).toContain('secret');
    expect(
      expect400(() => parseFilterParams({ filter: { status: { gt: '1' } } }, { fields })).message,
    ).toContain('"gt"');
    expect400(() => parseFilterParams({ 'filter[nope]': 'x' }, { fields }));
    expect400(() => parseFilterParams({ 'filter[status][lt]': 'x' }, { fields }));
    // a list on an `eq`-only field is operator `in`, which createdAt does not support
    expect400(() => parseFilterParams({ filter: { createdAt: 'a,b' } }, { fields }));
  });

  it('rejects malformed shapes with a 400', () => {
    expect400(() => parseFilterParams({ filter: 'status:eq:open' }, { fields }));
    expect400(() => parseFilterParams({ filter: { createdAt: { gte: ['a', 'b'] } } }, { fields }));
    expect400(() => parseFilterParams({ 'filter[status][eq][x]': 'a' }, { fields }));
    expect400(() => parseFilterParams({ filter: { status: { eq: { deep: 'x' } } } }, { fields }));
  });

  it('types field and op as a discriminated union', () => {
    const [first] = parseFilterParams({ filter: { createdAt: { gte: 'x' } } }, { fields });
    if (first?.field === 'createdAt') {
      const op: 'gte' | 'lte' = first.op;
      expect(op).toBe('gte');
    }
  });
});
