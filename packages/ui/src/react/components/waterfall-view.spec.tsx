import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Waterfall } from '../../client/index.js';
import { WaterfallView } from './waterfall-view.js';

const waterfall: Waterfall = {
  traceStartMs: 1000,
  totalDurationMs: 100,
  spans: [
    {
      id: 'req',
      type: 'request',
      label: 'GET /users',
      offsetMs: 0,
      durationMs: 100,
      depth: 0,
      sequence: 0,
      children: [
        {
          id: 'q1',
          type: 'query',
          label: 'select 1',
          offsetMs: 10,
          durationMs: 20,
          depth: 1,
          sequence: 1,
          children: [],
        },
      ],
    },
  ],
};

describe('WaterfallView', () => {
  it('renders a row per span, including nested children', () => {
    render(<WaterfallView waterfall={waterfall} />);
    const rows = screen.getAllByTestId('waterfall-row');
    expect(rows).toHaveLength(2);
    expect(screen.getByText('GET /users')).toBeTruthy();
    expect(screen.getByText('select 1')).toBeTruthy();
  });

  it('fires onSelect with the span id when a row is clicked', () => {
    const onSelect = vi.fn();
    render(<WaterfallView waterfall={waterfall} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('select 1'));
    expect(onSelect).toHaveBeenCalledWith('q1');
  });

  it('shows an empty state when there are no spans', () => {
    render(<WaterfallView waterfall={{ traceStartMs: 0, totalDurationMs: 0, spans: [] }} />);
    expect(screen.getByText('No spans in this trace')).toBeTruthy();
  });
});
