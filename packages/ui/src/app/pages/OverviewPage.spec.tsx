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
import {
  OverviewPage,
  QUEUE_WAITING_ATTENTION_THRESHOLD,
  deriveErrorRate,
  deriveSlowRequestCount,
  formatErrorRate,
  queuesNeedingAttention,
  toByTypeRows,
  toThroughputSeries,
} from './OverviewPage.js';

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
  slowJobs: [{ route: 'mail:send', count: 3, p99: 540, p50: 100 }],
  loadByUser: [{ user: 'alice', count: 9, totalDurationMs: 1200 }],
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
      retention: { afterMs: 3_600_000, keepLast: null },
      pruneEnabled: true,
      explainEnabled: false,
      sampling: {},
    }),
    serverStats: async () => serverStats,
    serverStatsHistory: async () => ({ samples: [] }),
    health: async () => healthOverride,
    retention: async () => ({
      retention: { afterMs: 3_600_000, keepLast: null },
      entryCount: null,
      oldestCreatedAt: null,
      pruneSupported: true,
    }),
    prune: async () => ({ pruned: 0 }),
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

describe('deriveErrorRate', () => {
  it('divides exceptions by requests as a [0,1] fraction', () => {
    expect(deriveErrorRate({ request: 100, exception: 5 })).toBeCloseTo(0.05);
    expect(deriveErrorRate({ request: 4, exception: 1 })).toBeCloseTo(0.25);
  });

  it('returns null on an idle window rather than a misleading 0%', () => {
    // no requests: the rate is undefined, not zero
    expect(deriveErrorRate({ exception: 3 })).toBeNull();
    expect(deriveErrorRate({})).toBeNull();
  });

  it('is zero when there are requests but no exceptions', () => {
    expect(deriveErrorRate({ request: 50 })).toBe(0);
  });
});

describe('formatErrorRate', () => {
  it('renders a fraction as a one-decimal percentage', () => {
    expect(formatErrorRate(0.286)).toBe('28.6%');
    expect(formatErrorRate(0)).toBe('0.0%');
  });

  it('renders null as n/a', () => {
    expect(formatErrorRate(null)).toBe('n/a');
  });
});

describe('deriveSlowRequestCount', () => {
  it('counts the over-threshold slow-route families pulse flagged', () => {
    // `slowRoutes` is already filtered server-side to routes whose p99 is over
    // the slow threshold, so the stat is simply that list's length.
    expect(
      deriveSlowRequestCount({
        ...pulse,
        slowRoutes: [
          { route: 'GET /a', count: 3, p99: 1100, p50: 100 },
          { route: 'GET /b', count: 1, p99: 1200, p50: 200 },
        ],
      }),
    ).toBe(2);
  });

  it('is zero when no route is over the slow threshold or pulse is absent', () => {
    // An empty slowRoutes now means "no route over the slow threshold" — the
    // honest quiet-host reading, not "no traffic".
    expect(deriveSlowRequestCount({ ...pulse, slowRoutes: [] })).toBe(0);
    expect(deriveSlowRequestCount(undefined)).toBe(0);
  });
});

describe('queuesNeedingAttention', () => {
  function queueMetrics(over: Partial<QueueMetricsReport['queues'][number]>) {
    return {
      queue: 'q',
      total: 0,
      completed: 0,
      failed: 0,
      failureRate: 0,
      throughputPerMinute: 0,
      runtimeMs: null,
      waitMs: null,
      ...over,
    };
  }

  it('flags queues with any failed jobs', () => {
    const report: QueueMetricsReport = {
      ...queues,
      queues: [queueMetrics({ queue: 'mail', failed: 2, total: 10, completed: 8 })],
    };
    expect(queuesNeedingAttention(report).map((q) => q.queue)).toEqual(['mail']);
  });

  it('flags queues with a large pending backlog even with no failures', () => {
    const pending = QUEUE_WAITING_ATTENTION_THRESHOLD;
    const report: QueueMetricsReport = {
      ...queues,
      queues: [queueMetrics({ queue: 'big', total: pending + 5, completed: 5, failed: 0 })],
    };
    expect(queuesNeedingAttention(report).map((q) => q.queue)).toEqual(['big']);
  });

  it('ignores healthy queues (no failures, small backlog)', () => {
    const report: QueueMetricsReport = {
      ...queues,
      queues: [
        queueMetrics({ queue: 'ok', total: 50, completed: 50, failed: 0 }),
        queueMetrics({ queue: 'tiny-backlog', total: 10, completed: 5, failed: 0 }),
      ],
    };
    expect(queuesNeedingAttention(report)).toEqual([]);
  });

  it('returns an empty list when there is no queue report', () => {
    expect(queuesNeedingAttention(undefined)).toEqual([]);
  });
});

describe('OverviewPage', () => {
  it('renders stat numbers, chart titles, and lists from the mocked data', async () => {
    renderOverview();
    expect(await screen.findByText('Overview')).toBeTruthy();
    await waitFor(() => {
      // requests = 7, with the total-entries figure (24) demoted to a hint
      expect(screen.getByText('7')).toBeTruthy();
    });
    expect(screen.getByText('24 entries total')).toBeTruthy();
    expect(screen.getByText('Throughput')).toBeTruthy();
    expect(screen.getByText('By type')).toBeTruthy();
    expect(screen.getByText('Recent failures')).toBeTruthy();
    expect(screen.getByText('Slowest')).toBeTruthy();
    expect(screen.getByText('N+1 query hotspots')).toBeTruthy();
    expect(screen.getByText('Queues needing attention')).toBeTruthy();
    expect(screen.getByText('TypeError')).toBeTruthy();
    expect(screen.getByText('select * from big')).toBeTruthy();
  });

  it('derives and renders the error rate from exceptions ÷ requests', async () => {
    renderOverview();
    expect(await screen.findByText('Error rate')).toBeTruthy();
    // 2 exceptions ÷ 7 requests = 28.6%
    await waitFor(() => {
      expect(screen.getByText('28.6%')).toBeTruthy();
    });
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

  it('renders the slowest-jobs and load-by-user rollup cards', async () => {
    renderOverview();
    expect(await screen.findByText('Slowest jobs')).toBeTruthy();
    expect(await screen.findByText('mail:send')).toBeTruthy();
    expect(await screen.findByText('Load by user')).toBeTruthy();
    expect(await screen.findByText('alice')).toBeTruthy();
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
