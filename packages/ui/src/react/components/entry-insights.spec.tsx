import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { StatsResult, TelescopeClient, TimeseriesReport } from '../../client/index.js';
import { TelescopeProvider } from '../telescope-context.js';
import { EntryInsights } from './entry-insights.js';

const overTime: TimeseriesReport = {
  windowStart: '',
  windowEnd: '',
  bucketMs: 60_000,
  scanned: 2,
  truncated: false,
  buckets: [
    { t: '2026-06-03T12:00:00Z', total: 3, byType: {} },
    { t: '2026-06-03T12:01:00Z', total: 5, byType: {} },
  ],
};

function statsFor(over: Partial<StatsResult> & { type: string }): StatsResult {
  return {
    windowMs: 3_600_000,
    total: 8,
    overTime,
    truncated: false,
    ...over,
  };
}

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
    meta: async () => ({ enabled: true, droppedCount: 0, watchers: [], traceLink: null }),
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

function renderInsights(type: string, stats: StatsResult) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <TelescopeProvider client={mockClient(stats)}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <EntryInsights type={type} />
        </MemoryRouter>
      </QueryClientProvider>
    </TelescopeProvider>,
  );
}

describe('EntryInsights', () => {
  it('renders query p99, the families bar card, and the over-time area', async () => {
    const stats = statsFor({
      type: 'query',
      latency: { count: 8, p50: 4, p95: 30, p99: 42, max: 50, slow: 2 },
      families: [{ familyHash: 'h1', label: 'select * from users', count: 5, p50: 4, p99: 42 }],
    });
    renderInsights('query', stats);

    expect(await screen.findByText('p99 ms')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('Slowest query shapes (p99)')).toBeTruthy();
    expect(screen.getByText('Queries over time')).toBeTruthy();
  });

  it('renders cache hit ratio, the hits/misses card, and top keys', async () => {
    const stats = statsFor({
      type: 'cache',
      cache: {
        hits: 6,
        misses: 2,
        sets: 1,
        hitRatio: 0.75,
        topKeys: [{ key: 'user:1', count: 4 }],
      },
    });
    renderInsights('cache', stats);

    expect(await screen.findByText('Hit ratio')).toBeTruthy();
    expect(screen.getByText('75%')).toBeTruthy();
    expect(screen.getByText('Hits vs misses')).toBeTruthy();
    expect(screen.getByText('Top keys')).toBeTruthy();
  });

  it('renders the status-codes card and error percentage for requests', async () => {
    const stats = statsFor({
      type: 'request',
      total: 10,
      latency: { count: 10, p50: 5, p95: 40, p99: 60, max: 90, slow: 1 },
      status: { '2xx': 7, '3xx': 0, '4xx': 2, '5xx': 1, other: 0 },
    });
    renderInsights('request', stats);

    expect(await screen.findByText('Status codes')).toBeTruthy();
    expect(screen.getByText('Error %')).toBeTruthy();
    // (4xx + 5xx) / total = 3 / 10 = 30%
    expect(screen.getByText('30%')).toBeTruthy();
  });

  it('renders exception groups with class, message, count, and a drill-through link', async () => {
    const stats = statsFor({
      type: 'exception',
      total: 5,
      exceptions: [
        {
          key: 'TypeError:boom',
          class: 'TypeError',
          message: 'cannot read property of undefined',
          count: 3,
          lastAt: new Date(Date.now() - 30_000).toISOString(),
          overTime: [0, 1, 0, 1, 0, 1],
        },
        {
          key: 'RangeError:nope',
          class: 'RangeError',
          message: 'out of range',
          count: 2,
          lastAt: new Date(Date.now() - 120_000).toISOString(),
          overTime: [1, 0, 1, 0, 0, 0],
        },
      ],
    });
    const { container } = renderInsights('exception', stats);

    expect(await screen.findByText('Exception groups')).toBeTruthy();
    expect(screen.getByText('TypeError')).toBeTruthy();
    expect(screen.getByText('cannot read property of undefined')).toBeTruthy();
    expect(screen.getByText('RangeError')).toBeTruthy();
    // Drill-through link to the family scoped to the exception type. (MemoryRouter
    // renders the path without the HashRouter `#` prefix used by the real app.)
    const hrefs = [...container.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href'));
    expect(hrefs).toContain('/entries/exception?familyHash=TypeError%3Aboom');
  });

  it('renders a generic total + over-time header for other types', async () => {
    const stats = statsFor({ type: 'mail', total: 4 });
    renderInsights('mail', stats);

    expect(await screen.findByText('Total')).toBeTruthy();
    expect(screen.getByText('Over time')).toBeTruthy();
    expect(screen.queryByText('Status codes')).toBeNull();
    expect(screen.queryByText('Hit ratio')).toBeNull();
  });

  it('shows the sampled note when truncated', async () => {
    const stats = statsFor({ type: 'mail', truncated: true });
    renderInsights('mail', stats);

    expect(await screen.findByText('sampled (window capped)')).toBeTruthy();
  });
});
