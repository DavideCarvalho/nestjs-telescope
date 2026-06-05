import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type {
  PulseReport,
  QueueMetricsReport,
  TelescopeClient,
  TelescopeHealth,
  TimeseriesReport,
} from '../../client/index.js';
import { TelescopeProvider } from '../../react/index.js';
import { OverviewPage, toByTypeRows, toThroughputSeries } from './OverviewPage.js';

const pulse: PulseReport = {
  windowStart: '',
  windowEnd: '',
  windowMs: 3_600_000,
  scanned: 5,
  truncated: false,
  counts: { request: 7, query: 12, job: 3, exception: 2 },
  slowest: [
    { id: 'slow1', type: 'query', durationMs: 480, label: 'select * from big', batchId: 'b' },
  ],
  topExceptions: [
    {
      familyHash: 'Error:boom',
      class: 'TypeError',
      message: 'cannot read x',
      count: 4,
      lastSeen: '',
    },
  ],
  nPlusOne: [],
  slowRoutes: [],
  slowOutgoing: [],
};

const serverStats = {
  uptimeSec: 7325,
  memory: { rssMb: 128.5, heapUsedMb: 64.2, heapTotalMb: 96.0 },
  cpu: { userMs: 1200, systemMs: 300 },
  eventLoopDelayMs: 1.25,
  instanceId: 'instance-abc',
};

const health = {
  enabled: true,
  recorded: 4200,
  bufferSize: 500,
  bufferUsed: 37,
  bufferHighWater: 210,
  flushes: 84,
  flushedEntries: 4163,
  lastFlushMs: 2.4,
  maxFlushMs: 11.7,
  totalFlushMs: 190.3,
  overflowDropped: 0,
  storeFailedDropped: 0,
  droppedCount: 0,
  truncatedCount: 0,
  captureCostNanos: 8700,
};

const queues: QueueMetricsReport = {
  windowStart: '',
  windowEnd: '',
  windowMs: 3_600_000,
  scanned: 5,
  truncated: false,
  queues: [
    {
      queue: 'mail',
      total: 30,
      completed: 28,
      failed: 2,
      failureRate: 0.066,
      throughputPerMinute: 4.5,
      runtimeMs: null,
      waitMs: null,
    },
  ],
};

const timeseries: TimeseriesReport = {
  windowStart: '',
  windowEnd: '',
  bucketMs: 60_000,
  scanned: 5,
  truncated: false,
  buckets: [
    { t: '2026-06-03T12:00:00Z', total: 5, byType: { request: 3, query: 2 } },
    { t: '2026-06-03T12:01:00Z', total: 8, byType: { request: 5, query: 3 } },
  ],
};

function mockClient(healthOverride: TelescopeHealth = health): TelescopeClient {
  return {
    entries: async () => ({ data: [], nextCursor: null }),
    entry: async () => {
      throw new Error('not used');
    },
    pulse: async () => pulse,
    queues: async () => queues,
    timeseries: async () => timeseries,
    stats: async () => {
      throw new Error('not used');
    },
    meta: async () => ({
      enabled: true,
      droppedCount: 0,
      watchers: [],
      traceLink: null,
      retention: null,
      sampling: {},
    }),
    serverStats: async () => serverStats,
    health: async () => healthOverride,
  };
}

function renderOverview(healthOverride: TelescopeHealth = health) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <TelescopeProvider client={mockClient(healthOverride)}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <OverviewPage />
        </MemoryRouter>
      </QueryClientProvider>
    </TelescopeProvider>,
  );
}

describe('OverviewPage transforms', () => {
  it('maps timeseries totals to throughput points', () => {
    expect(toThroughputSeries(timeseries).map((point) => point.value)).toEqual([5, 8]);
  });

  it('maps timeseries byType into stacked rows with a key per type', () => {
    const rows = toByTypeRows(timeseries);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.request).toBe(3);
    expect(rows[0]?.query).toBe(2);
  });
});

describe('OverviewPage', () => {
  it('renders stat numbers, chart titles, and lists from the mocked data', async () => {
    renderOverview();
    expect(await screen.findByText('Overview')).toBeTruthy();
    await waitFor(() => {
      // total entries = 7 + 12 + 3 + 2 = 24
      expect(screen.getByText('24')).toBeTruthy();
    });
    expect(screen.getByText('Throughput')).toBeTruthy();
    expect(screen.getByText('By type')).toBeTruthy();
    expect(screen.getByText('Recent failures')).toBeTruthy();
    expect(screen.getByText('Slowest')).toBeTruthy();
    expect(screen.getByText('TypeError')).toBeTruthy();
    expect(screen.getByText('select * from big')).toBeTruthy();
  });

  it('renders the Server card from the server-stats snapshot', async () => {
    renderOverview();
    expect(await screen.findByText('Server')).toBeTruthy();
    await waitFor(() => {
      // uptime 7325s => 2h 2m
      expect(screen.getByText('2h 2m')).toBeTruthy();
    });
    expect(screen.getByText('128.5 MB')).toBeTruthy();
    expect(screen.getByText('1.25 ms')).toBeTruthy();
    expect(screen.getByText('instance instance-abc')).toBeTruthy();
  });

  it('renders the Telescope health card with capture cost, buffer, flush, and dropped figures', async () => {
    renderOverview();
    expect(await screen.findByText('Telescope health')).toBeTruthy();
    await waitFor(() => {
      // 8700ns => 8.7 µs/capture
      expect(screen.getByText('8.7 µs/capture')).toBeTruthy();
    });
    expect(screen.getByText('37 / 500')).toBeTruthy();
    expect(screen.getByText('high-water 210')).toBeTruthy();
    expect(screen.getByText('2.4 ms')).toBeTruthy();
    // dropped = 0 is shown as the reassuring "keeping up" state
    const dropped = screen.getByText('keeping up');
    expect(dropped).toBeTruthy();
    expect(dropped.previousElementSibling?.className).toContain('text-emerald-400');
  });

  it('highlights the dropped figure when Telescope is shedding load', async () => {
    renderOverview({
      ...health,
      overflowDropped: 12,
      storeFailedDropped: 3,
      droppedCount: 15,
    });
    expect(await screen.findByText('Telescope health')).toBeTruthy();
    const hint = await screen.findByText('overflow 12 · store 3');
    expect(hint).toBeTruthy();
    // the dropped value sits above the hint and turns red when > 0
    const value = hint.previousElementSibling;
    expect(value?.textContent).toBe('15');
    expect(value?.className).toContain('text-red-400');
  });

  it('surfaces the truncated counter when content is being clipped by redaction bounds', async () => {
    renderOverview({ ...health, truncatedCount: 9 });
    const hint = await screen.findByText('fat content — tune redact/sampling');
    expect(hint).toBeTruthy();
    const value = hint.previousElementSibling;
    expect(value?.textContent).toBe('9');
    expect(value?.className).toContain('text-amber-400');
  });
});
