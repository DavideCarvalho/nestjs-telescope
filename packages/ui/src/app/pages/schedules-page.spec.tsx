import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { ScheduledTask, TelescopeClient } from '../../client/index.js';
import { TelescopeProvider } from '../../react/index.js';
import { DashboardLayout } from '../dashboard-layout.js';
import { SchedulesPage } from './schedules-page.js';

const TASKS: ScheduledTask[] = [
  {
    name: 'nightly-report',
    kind: 'cron',
    schedule: '0 0 * * *',
    nextRunAt: '2099-06-04T00:00:00.000Z',
    lastRunAt: new Date(Date.now() - 5000).toISOString(),
    lastDurationMs: 1234,
    lastStatus: 'completed',
  },
  {
    name: 'heartbeat',
    kind: 'interval',
    schedule: 'interval',
    nextRunAt: null,
    lastRunAt: null,
    lastDurationMs: null,
    lastStatus: null,
  },
];

function mockClient(tasks: ScheduledTask[]): TelescopeClient {
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
    traces: async () => {
      throw new Error('not used');
    },
    stats: async () => {
      throw new Error('not used');
    },
    tags: async () => [],
    meta: async () => ({
      enabled: true,
      droppedCount: 0,
      watchers: [],
      traceLink: null,
      retention: null,
      sampling: {},
    }),
    liveQueues: async () => ({
      queues: [],
      capabilities: { mutationsEnabled: false, actionsByDriver: {} },
    }),
    schedulesLive: async () => ({ tasks }),
    queueCounts: async () => ({
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
      paused: 0,
    }),
    queueJobs: async () => ({ jobs: [], nextCursor: null, total: 0 }),
    queueJob: async () => null,
    queueJobAction: async () => ({ ok: true }),
    queueAction: async () => ({ ok: true }),
    queueEnqueue: async () => ({ id: null }),
  };
}

function renderPage(tasks: ScheduledTask[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <TelescopeProvider client={mockClient(tasks)}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SchedulesPage />
        </MemoryRouter>
      </QueryClientProvider>
    </TelescopeProvider>,
  );
}

describe('SchedulesPage', () => {
  it('renders rows with schedule, next-run and last-run info', async () => {
    renderPage(TASKS);
    expect(await screen.findByText('nightly-report')).toBeTruthy();
    expect(screen.getByText('0 0 * * *')).toBeTruthy();
    expect(screen.getByText('heartbeat')).toBeTruthy();
    // last-run relative time for the cron task
    expect(screen.getByText(/ago/)).toBeTruthy();
    // last status badge
    expect(screen.getByText('completed')).toBeTruthy();
  });

  it('shows an empty state when there are no tasks', async () => {
    renderPage([]);
    expect(await screen.findByText(/No scheduled tasks detected/)).toBeTruthy();
  });
});

describe('dashboard nav', () => {
  it('includes a Schedule console link', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <TelescopeProvider client={mockClient([])}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <DashboardLayout>{null}</DashboardLayout>
          </MemoryRouter>
        </QueryClientProvider>
      </TelescopeProvider>,
    );
    const link = screen.getByRole('link', { name: 'Schedules' });
    expect(link.getAttribute('href')).toBe('/schedules');
  });
});
