import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { QueueCapabilities, QueueSummary, TelescopeClient } from '../../../client/index.js';
import { TelescopeProvider } from '../../telescope-context.js';
import { QueueList } from './QueueList.js';

const summaries: QueueSummary[] = [
  {
    driver: 'bullmq',
    queue: 'mail',
    isPaused: false,
    counts: { waiting: 3, active: 1, delayed: 2, failed: 4, completed: 50, paused: 0 },
  },
  {
    driver: 'bullmq',
    queue: 'sms',
    isPaused: true,
    counts: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 7, paused: 0 },
  },
];

const capabilities: QueueCapabilities = { mutationsEnabled: false, actionsByDriver: {} };

function mockClient(): TelescopeClient {
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
    stats: async () => {
      throw new Error('not used');
    },
    meta: async () => ({ enabled: true, droppedCount: 0, watchers: [], traceLink: null }),
    liveQueues: async () => ({ queues: summaries, capabilities }),
    queueCounts: async () => summaries[0]?.counts ?? ({} as never),
    queueJobs: async () => ({ jobs: [], nextCursor: null, total: 0 }),
    queueJob: async () => null,
    queueJobAction: async () => ({ ok: true }),
    queueAction: async () => ({ ok: true }),
  };
}

function renderList() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <TelescopeProvider client={mockClient()}>
      <QueryClientProvider client={queryClient}>
        <QueueList onSelect={() => {}} />
      </QueryClientProvider>
    </TelescopeProvider>,
  );
}

describe('QueueList', () => {
  it('renders a row per queue with state counts and a paused indicator', async () => {
    renderList();
    expect(await screen.findByText('mail')).toBeTruthy();
    expect(screen.getByText('sms')).toBeTruthy();
    // failed count for mail
    expect(screen.getByText('4')).toBeTruthy();
    // completed count for mail
    expect(screen.getByText('50')).toBeTruthy();
    // sms is paused
    expect(screen.getByText('paused')).toBeTruthy();
  });
});
