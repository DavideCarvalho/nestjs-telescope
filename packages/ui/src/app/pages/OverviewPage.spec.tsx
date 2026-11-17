import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NuqsHashAdapter } from '../../aviary-kit/url-state/nuqs-hash-adapter';
import type {
  PulseReport,
  QueueMetricsReport,
  TelescopeClient,
  TelescopeHealth,
  TimeseriesReport,
} from '../../client/index.js';
import { TelescopeProvider } from '../../react/index.js';
import { LAST_PAGE_META, mockTelescopeClient } from '../../testing/mock-telescope-client.js';
import { settleUrlWrites } from '../settle-url.js';
import {
  OVERVIEW_PULSE,
  OverviewPage,
  QUEUE_WAITING_ATTENTION_THRESHOLD,
  deriveErrorRate,
  deriveSlowRequestCount,
  formatErrorRate,
  queuesNeedingAttention,
  slowWorkView,
  toByTypeRows,
  toThroughputSeries,
} from './OverviewPage.js';

afterEach(settleUrlWrites);

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

function mockClient(
  healthOverride: TelescopeHealth = health,
  watchers: string[] | null | undefined = undefined,
  pulseOverride: PulseReport = pulse,
): TelescopeClient {
  return mockTelescopeClient({
    entries: async () => ({ data: [], meta: LAST_PAGE_META }),
    pulse: async () => pulseOverride,
    queues: async () => queues,
    timeseries: async () => timeseries,
    meta: async () => ({
      enabled: true,
      droppedCount: 0,
      ...(watchers !== undefined ? { watchers } : {}),
      traceLink: null,
      retention: { afterMs: 3_600_000, keepLast: null },
      pruneEnabled: true,
      explainEnabled: false,
      sampling: {},
      tracesEnabled: true,
      ai: { enabled: false, mode: null },
      entryTypes: [],
      dashboards: [],
      profiling: { enabled: false, sampleRate: 0 },
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
  });
}

function renderOverview(
  healthOverride: TelescopeHealth = health,
  view: { watchers?: string[] | null; pulse?: PulseReport } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client =
    'watchers' in view
      ? mockClient(healthOverride, view.watchers, view.pulse ?? pulse)
      : mockClient(healthOverride, undefined, view.pulse ?? pulse);
  return render(
    <TelescopeProvider client={client}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <NuqsHashAdapter>
            <OverviewPage />
          </NuqsHashAdapter>
        </MemoryRouter>
      </QueryClientProvider>
    </TelescopeProvider>,
  );
}

function renderWith(client: TelescopeClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <TelescopeProvider client={client}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <NuqsHashAdapter>
            <OverviewPage />
          </NuqsHashAdapter>
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

  it('reads the window once: its cards and the charts come from one Pulse read', async () => {
    const client = mockClient();
    const pulseRead = vi.fn(async () => ({ ...pulse, timeseries }));
    const timeseriesRead = vi.fn(async () => timeseries);
    client.pulse = pulseRead;
    client.timeseries = timeseriesRead;
    renderWith(client);
    expect(await screen.findByText('24 entries total')).toBeTruthy();
    expect(pulseRead).toHaveBeenCalledWith('1h', OVERVIEW_PULSE);
    expect(OVERVIEW_PULSE.cards).not.toContain('slowOutgoing');
    expect(timeseriesRead).not.toHaveBeenCalled();
  });

  it('reads the chart apart from a server that answers Pulse without a timeseries', async () => {
    const client = mockClient();
    const timeseriesRead = vi.fn(async () => timeseries);
    client.timeseries = timeseriesRead;
    renderWith(client);
    await waitFor(() => expect(timeseriesRead).toHaveBeenCalledWith({ window: '1h', buckets: 60 }));
  });

  it('still draws the charts when the Pulse read fails', async () => {
    const client = mockClient();
    client.pulse = vi.fn(async () => {
      throw new Error('pulse down');
    });
    const timeseriesRead = vi.fn(async () => timeseries);
    client.timeseries = timeseriesRead;
    renderWith(client);
    await waitFor(() => expect(timeseriesRead).toHaveBeenCalledWith({ window: '1h', buckets: 60 }));
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

  it('says "Not measured" on N+1 and slow jobs only when meta positively lists neither watcher', async () => {
    const idle = { ...pulse, nPlusOne: [], slowJobs: [] };
    renderOverview(health, { watchers: ['request', 'exception'], pulse: idle });
    expect(await screen.findByTestId('not-measured-query')).toBeTruthy();
    expect(await screen.findByTestId('not-measured-slow-work')).toBeTruthy();
    expect(screen.queryByText('None detected')).toBeNull();
  });

  it('keeps "None detected" when meta does not say (a control plane where an app does not report)', async () => {
    const idle = { ...pulse, nPlusOne: [], slowJobs: [] };
    renderOverview(health, { watchers: null, pulse: idle });
    expect(await screen.findByText('None detected')).toBeTruthy();
    expect(await screen.findByText('No jobs or workflow steps in this window.')).toBeTruthy();
    expect(screen.queryByTestId('not-measured-query')).toBeNull();
  });

  it('lists durable workflow steps with the jobs, by p95 with max, count and failures', async () => {
    renderOverview(health, {
      watchers: ['request', 'exception', 'durable'],
      pulse: {
        ...pulse,
        slowWork: [
          {
            source: 'durable',
            name: 'charge-card',
            count: 12,
            failures: 2,
            p50: 800,
            p95: 4200,
            max: 9100,
          },
        ],
      },
    });
    expect(await screen.findByText('charge-card')).toBeTruthy();
    expect(screen.getByText('step')).toBeTruthy();
    expect(screen.getByText(/9100ms max · 12×/)).toBeTruthy();
    expect(screen.getByText('· 2 failed')).toBeTruthy();
    expect(screen.queryByTestId('not-measured-slow-work')).toBeNull();
  });

  it('durable on and a quiet window: no "Not measured" though no job watcher runs', async () => {
    renderOverview(health, {
      watchers: ['request', 'exception', 'durable'],
      pulse: { ...pulse, slowJobs: [], slowWork: [] },
    });
    expect(
      await screen.findByText('Durable is reporting. No workflow step finished in this window.'),
    ).toBeTruthy();
    expect(screen.queryByTestId('not-measured-slow-work')).toBeNull();
  });

  it('keeps "None detected" when the query watcher runs and found nothing', async () => {
    renderOverview(health, {
      watchers: ['request', 'query', 'job'],
      pulse: { ...pulse, nPlusOne: [] },
    });
    expect(await screen.findByText('None detected')).toBeTruthy();
    expect(screen.queryByTestId('not-measured-query')).toBeNull();
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
    expect(dropped.previousElementSibling?.className).toContain('text-good');
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
    // the dropped value sits above the hint and turns `--bad` when > 0
    const value = hint.previousElementSibling;
    expect(value?.textContent).toBe('15');
    expect(value?.className).toContain('text-bad');
  });

  it('surfaces the truncated counter when content is being clipped by redaction bounds', async () => {
    renderOverview({ ...health, truncatedCount: 9 });
    const hint = await screen.findByText('fat content — tune redact/sampling');
    expect(hint).toBeTruthy();
    const value = hint.previousElementSibling;
    expect(value?.textContent).toBe('9');
    expect(value?.className).toContain('text-warn');
  });
});

describe('slowWorkView', () => {
  const step = {
    source: 'durable' as const,
    name: 'charge-card',
    count: 3,
    failures: 0,
    p50: 10,
    p95: 20,
    max: 30,
  };
  const off = { durable: false, queue: false };
  const empty = { slowJobs: [], slowWork: [], counts: {} };

  it('rows win whatever the flags say', () => {
    expect(slowWorkView({ ...empty, slowWork: [step] }, off)).toEqual({
      kind: 'rows',
      rows: [step],
    });
  });

  it('an older server (no slowWork) still lists its job hotspots', () => {
    const view = slowWorkView(
      { slowJobs: [{ route: 'mail:send', count: 3, p99: 700, p50: 100 }], counts: {} },
      off,
    );
    expect(view).toEqual({
      kind: 'rows',
      rows: [
        { source: 'queue', name: 'mail:send', count: 3, failures: 0, p50: 100, p95: 700, max: 700 },
      ],
    });
  });

  it('"not measured" only when neither durable nor a job watcher is on', () => {
    expect(slowWorkView(empty, off)).toEqual({ kind: 'off' });
    expect(slowWorkView(empty, { durable: true, queue: false }).kind).toBe('quiet');
    expect(slowWorkView(empty, { durable: false, queue: true })).toEqual({
      kind: 'quiet',
      message: 'No jobs in window.',
    });
    expect(slowWorkView(empty, { durable: true, queue: true })).toEqual({
      kind: 'quiet',
      message: 'No job or workflow step finished in this window.',
    });
  });

  it('unknown (null) never claims a source is off', () => {
    expect(slowWorkView(empty, { durable: null, queue: null })).toEqual({
      kind: 'quiet',
      message: 'No jobs or workflow steps in this window.',
    });
  });

  it('durable entries but no timed step (an older durable): names the release that times steps', () => {
    const view = slowWorkView(
      { ...empty, counts: { durable: 14 } },
      { durable: true, queue: false },
    );
    expect(view.kind).toBe('quiet');
    expect(view.kind === 'quiet' && view.message).toContain('14 workflow events');
    expect(view.kind === 'quiet' && view.message).toContain(
      '@dudousxd/nestjs-durable-telescope 0.13.0',
    );
  });
});
