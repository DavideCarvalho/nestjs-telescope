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
      totalDurationMs: 240,
      sampleBatchId: 'b',
    },
  ],
  slowRoutes: [{ route: 'GET /api/base/:id/mel', count: 42, p99: 1200, p50: 80 }],
  slowOutgoing: [{ route: 'GET api.stripe.com/v1/charges/:id', count: 7, p99: 950, p50: 120 }],
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

  it('renders slow request hotspots with p99 and count', () => {
    render(<PulsePanel report={report} />);
    const section = screen.getByText('Slow request hotspots').closest('section');
    expect(section).toBeInstanceOf(HTMLElement);
    if (section instanceof HTMLElement) {
      expect(within(section).getByText('GET /api/base/:id/mel')).toBeTruthy();
      expect(within(section).getByText(/1200ms/)).toBeTruthy();
      expect(within(section).getByText('×42')).toBeTruthy();
    }
  });

  it('links a slow route to its request family', () => {
    const onSelectRoute = vi.fn();
    render(<PulsePanel report={report} onSelectRoute={onSelectRoute} />);
    fireEvent.click(screen.getByText('GET /api/base/:id/mel'));
    expect(onSelectRoute).toHaveBeenCalledWith('GET /api/base/:id/mel');
  });

  it('shows a threshold-aware empty state when no route is over the slow threshold', () => {
    render(<PulsePanel report={{ ...report, slowRoutes: [] }} />);
    const section = screen.getByText('Slow request hotspots').closest('section');
    expect(section).toBeInstanceOf(HTMLElement);
    if (section instanceof HTMLElement) {
      expect(within(section).getByText('No routes over the slow threshold')).toBeTruthy();
    }
  });

  it('shows a threshold-aware empty state for outgoing HTTP with no slow calls', () => {
    render(<PulsePanel report={{ ...report, slowOutgoing: [] }} />);
    const section = screen.getByText('Slow outgoing HTTP').closest('section');
    expect(section).toBeInstanceOf(HTMLElement);
    if (section instanceof HTMLElement) {
      expect(within(section).getByText('No outgoing calls over the slow threshold')).toBeTruthy();
    }
  });

  it('renders slow outgoing HTTP hotspots with p99 and count', () => {
    render(<PulsePanel report={report} />);
    const section = screen.getByText('Slow outgoing HTTP').closest('section');
    expect(section).toBeInstanceOf(HTMLElement);
    if (section instanceof HTMLElement) {
      expect(within(section).getByText('GET api.stripe.com/v1/charges/:id')).toBeTruthy();
      expect(within(section).getByText(/950ms/)).toBeTruthy();
      expect(within(section).getByText('×7')).toBeTruthy();
    }
  });

  it('links a slow outgoing target to its http_client family', () => {
    const onSelectOutgoing = vi.fn();
    render(<PulsePanel report={report} onSelectOutgoing={onSelectOutgoing} />);
    fireEvent.click(screen.getByText('GET api.stripe.com/v1/charges/:id'));
    expect(onSelectOutgoing).toHaveBeenCalledWith('GET api.stripe.com/v1/charges/:id');
  });
});
