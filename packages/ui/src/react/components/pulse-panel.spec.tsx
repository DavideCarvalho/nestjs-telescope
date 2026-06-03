import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PulseReport } from '../../client/index.js';
import { PulsePanel } from './pulse-panel.js';

const report: PulseReport = {
  windowStart: '',
  windowEnd: '',
  windowMs: 3_600_000,
  scanned: 3,
  truncated: false,
  counts: { query: 2, request: 1 },
  slowest: [{ id: 'e1', type: 'query', durationMs: 300, label: 'select 1', batchId: 'b' }],
  topExceptions: [
    { familyHash: 'Error:boom', class: 'Error', message: 'boom', count: 2, lastSeen: '' },
  ],
  nPlusOne: [
    {
      familyHash: 'q:x',
      sql: 'select * from t',
      perRequest: 6,
      requests: 3,
      total: 18,
      sampleBatchId: 'b',
    },
  ],
};

describe('PulsePanel', () => {
  it('renders counts, slowest, exceptions, and aggregated N+1', () => {
    render(<PulsePanel report={report} />);
    const countsSection = screen.getByText('Entries by type').closest('section');
    expect(countsSection).toBeTruthy();
    if (countsSection instanceof HTMLElement) {
      expect(within(countsSection).getByText('query')).toBeTruthy();
    }
    expect(screen.getByText('select 1')).toBeTruthy();
    expect(screen.getByText('boom')).toBeTruthy();
    expect(screen.getByText('×6')).toBeTruthy();
    expect(screen.getByText(/3 requests/)).toBeTruthy();
  });

  it('collapses identical families to a single hotspot row', () => {
    render(<PulsePanel report={report} />);
    const hotspotSection = screen.getByText('N+1 query hotspots').closest('section');
    expect(hotspotSection).toBeInstanceOf(HTMLElement);
    if (hotspotSection instanceof HTMLElement) {
      expect(within(hotspotSection).getAllByText('select * from t')).toHaveLength(1);
    }
  });

  it('links a hotspot to its query family', () => {
    const onSelectFamily = vi.fn();
    render(<PulsePanel report={report} onSelectFamily={onSelectFamily} />);
    fireEvent.click(screen.getByText('select * from t'));
    expect(onSelectFamily).toHaveBeenCalledWith('q:x');
  });
});
