import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { cloneElement, isValidElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { StatsResult, TelescopeClient, TimeseriesReport } from '../../client/index.js';
import { TelescopeProvider } from '../telescope-context.js';

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
}));

// jsdom measures ResponsiveContainer at 0x0 so chart bars never render. Mock
// the container to hand its child a fixed size, letting real <Bar> rectangles
// render and be clicked.
vi.mock('recharts', async () => {
  const actual = await vi.importActual<typeof import('recharts')>('recharts');
  function MockResponsiveContainer({ children }: { children: React.ReactNode }): JSX.Element {
    return (
      <div>
        {isValidElement(children) ? cloneElement(children, { width: 600, height: 300 }) : children}
      </div>
    );
  }
  return { ...actual, ResponsiveContainer: MockResponsiveContainer };
});

import { EntryInsights } from './entry-insights.js';

const overTime: TimeseriesReport = {
  windowStart: '',
  windowEnd: '',
  bucketMs: 60_000,
  scanned: 0,
  truncated: false,
  buckets: [],
};

function mockClient(stats: StatsResult): TelescopeClient {
  return {
    entries: async () => ({ data: [], nextCursor: null }),
    entry: async () => {
      throw new Error('not used');
    },
    pulse: async () => {
      throw new Error('not used');
    },
    queues: async () => {
      throw new Error('not used');
    },
    timeseries: async () => {
      throw new Error('not used');
    },
    stats: async () => stats,
    meta: async () => ({
      enabled: true,
      droppedCount: 0,
      watchers: [],
      traceLink: null,
      retention: null,
      sampling: {},
    }),
    liveQueues: async () => {
      throw new Error('not used');
    },
    queueCounts: async () => {
      throw new Error('not used');
    },
    queueJobs: async () => {
      throw new Error('not used');
    },
    queueJob: async () => null,
    queueJobAction: async () => ({ ok: true }),
    queueAction: async () => ({ ok: true }),
  };
}

describe('EntryInsights families chart click-through', () => {
  it('navigates to the query family when a families bar is clicked', async () => {
    navigate.mockClear();
    const stats: StatsResult = {
      type: 'query',
      windowMs: 3_600_000,
      total: 5,
      overTime,
      truncated: false,
      latency: { count: 5, p50: 4, p95: 30, p99: 42, max: 50, slow: 1 },
      families: [
        { familyHash: 'family/abc 123', label: 'select * from users', count: 5, p50: 4, p99: 42 },
      ],
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <TelescopeProvider client={mockClient(stats)}>
        <QueryClientProvider client={queryClient}>
          <EntryInsights type="query" />
        </QueryClientProvider>
      </TelescopeProvider>,
    );

    const bar = await waitFor(() => {
      const found = container.querySelector('.recharts-bar-rectangle');
      if (!found) throw new Error('families bar not rendered yet');
      return found;
    });
    fireEvent.click(bar);

    expect(navigate).toHaveBeenCalledWith('/entries/query?familyHash=family%2Fabc%20123');
  });
});
