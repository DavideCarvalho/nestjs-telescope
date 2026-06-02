import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
  nPlusOne: [{ batchId: 'b', familyHash: 'q:x', count: 6, sql: 'select * from t' }],
};

describe('PulsePanel', () => {
  it('renders counts, slowest, exceptions, and N+1', () => {
    render(<PulsePanel report={report} />);
    const countsSection = screen.getByText('Entries by type').closest('section');
    expect(countsSection).toBeTruthy();
    if (countsSection instanceof HTMLElement) {
      expect(within(countsSection).getByText('query')).toBeTruthy();
    }
    expect(screen.getByText('select 1')).toBeTruthy();
    expect(screen.getByText('boom')).toBeTruthy();
    expect(screen.getByText('×6')).toBeTruthy();
  });
});
