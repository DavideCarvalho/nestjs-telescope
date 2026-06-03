import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { QueueMetricsReport, TelescopeClient } from '../../client/index.js';
import { TelescopeProvider } from '../../react/index.js';
import { QueuesPage, toFailureRateBars } from './queues-page.js';

const report: QueueMetricsReport = {
  windowStart: '',
  windowEnd: '',
  windowMs: 3_600_000,
  scanned: 2,
  truncated: false,
  queues: [
    {
      queue: 'mail',
      total: 50,
      completed: 45,
      failed: 5,
      failureRate: 0.1,
      throughputPerMinute: 6,
      runtimeMs: null,
      waitMs: null,
    },
    {
      queue: 'sms',
      total: 20,
      completed: 20,
      failed: 0,
      failureRate: 0,
      throughputPerMinute: 2,
      runtimeMs: null,
      waitMs: null,
    },
  ],
};

function mockClient(): TelescopeClient {
  return {
    entries: async () => ({ data: [], nextCursor: null }),
    entry: async () => {
      throw new Error('not used');
    },
    pulse: async () => {
      throw new Error('not used');
    },
    queues: async () => report,
    timeseries: async () => ({
      windowStart: '',
      windowEnd: '',
      bucketMs: 60_000,
      buckets: [],
      scanned: 0,
      truncated: false,
    }),
    stats: async () => {
      throw new Error('not used');
    },
    meta: async () => ({ enabled: true, droppedCount: 0, watchers: [], traceLink: null }),
  };
}

describe('toFailureRateBars', () => {
  it('maps queue failure rates to percentage bars with severity color', () => {
    const bars = toFailureRateBars(report);
    expect(bars.map((bar) => bar.value)).toEqual([10, 0]);
    expect(bars[0]?.color).not.toBe(bars[1]?.color);
  });
});

describe('QueuesPage', () => {
  it('renders the failure-rate chart title and the queue table', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <TelescopeProvider client={mockClient()}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <QueuesPage />
          </MemoryRouter>
        </QueryClientProvider>
      </TelescopeProvider>,
    );
    expect(await screen.findByText('Failure rate by queue')).toBeTruthy();
    expect(await screen.findByText('mail')).toBeTruthy();
  });
});
