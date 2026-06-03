import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Entry } from '../../client/index.js';
import { RequestTimeline } from './request-timeline.js';

function entry(over: Partial<Entry>): Entry {
  return {
    id: 'x',
    batchId: 'b',
    type: 'query',
    familyHash: null,
    content: {},
    tags: [],
    sequence: 0,
    durationMs: 1,
    origin: 'http',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt: '2026-06-03T12:00:00Z',
    ...over,
  };
}

/** The width style of a row's duration bar (the inner styled span). */
function barWidth(row: HTMLElement): string {
  const bar = row.querySelector('span[style]');
  if (!(bar instanceof HTMLElement)) throw new Error('row has no duration bar');
  return bar.style.width;
}

const request = entry({
  id: 'req',
  type: 'request',
  sequence: 0,
  durationMs: 50,
  content: { method: 'GET', uri: '/users' },
});
const queryA = entry({
  id: 'q-a',
  type: 'query',
  sequence: 1,
  durationMs: 5,
  content: { sql: 'select * from users' },
});
const queryB = entry({
  id: 'q-b',
  type: 'query',
  sequence: 2,
  durationMs: 30,
  content: { sql: 'select * from orders' },
});
const cache = entry({
  id: 'c',
  type: 'cache',
  sequence: 3,
  durationMs: 1,
  content: { op: 'get', key: 'k' },
});

describe('RequestTimeline', () => {
  it('renders a row per batch entry in sequence order with labels and bars', () => {
    render(<RequestTimeline batch={[cache, request, queryB, queryA]} requestId="req" />);
    const rows = screen.getAllByRole('button');
    // request + 2 queries + cache = 4 rows
    expect(rows).toHaveLength(4);
    // ordered by sequence: request, queryA, queryB, cache
    expect(rows[0]?.textContent).toContain('GET /users');
    expect(rows[1]?.textContent).toContain('select * from users');
    expect(rows[2]?.textContent).toContain('select * from orders');
    // the request row (slowest) shows its duration
    expect(rows[0]?.textContent).toContain('50ms');
    // the cache row (sequence 3) renders last
    expect(rows[3]?.textContent).toContain('1ms');
    // each row has a duration bar element
    for (const row of rows) {
      expect(row.querySelector('span[style]')).toBeTruthy();
    }
  });

  it('scales the slowest entry to the widest bar (100%)', () => {
    render(<RequestTimeline batch={[request, queryA, queryB]} requestId="req" />);
    const rows = screen.getAllByRole('button');
    if (!rows[0] || !rows[2]) throw new Error('expected request and queryB rows');
    // request is the slowest (50ms) → full width
    expect(barWidth(rows[0])).toBe('100%');
    // queryB (30ms / 50ms) → 60%
    expect(barWidth(rows[2])).toBe('60%');
  });

  it('navigates to the child entry on click', () => {
    const onSelect = vi.fn();
    render(<RequestTimeline batch={[request, queryA]} requestId="req" onSelect={onSelect} />);
    const rows = screen.getAllByRole('button');
    if (!rows[1]) throw new Error('expected child row');
    fireEvent.click(rows[1]);
    expect(onSelect).toHaveBeenCalledWith('q-a');
  });

  it('renders a null-duration child without crashing', () => {
    const nullChild = entry({ id: 'n', type: 'query', sequence: 1, durationMs: null });
    render(<RequestTimeline batch={[request, nullChild]} requestId="req" />);
    const rows = screen.getAllByRole('button');
    if (!rows[1]) throw new Error('expected null-duration row');
    expect(rows[1].textContent).toContain('—');
    expect(barWidth(rows[1])).toBe('0%');
  });

  it('caps rendered rows and shows a "+N more" note for large batches', () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      entry({ id: `m-${index}`, sequence: index + 1, durationMs: 1 }),
    );
    render(<RequestTimeline batch={[request, ...many]} requestId="req" />);
    expect(screen.getAllByRole('button')).toHaveLength(50);
    expect(screen.getByText('+11 more')).toBeTruthy();
  });
});
