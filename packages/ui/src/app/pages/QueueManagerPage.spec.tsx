import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type {
  JobPage,
  QueueCapabilities,
  QueueSummary,
  TelescopeClient,
} from '../../client/index.js';
import { TelescopeProvider } from '../../react/index.js';
import { QueueManagerPage } from './QueueManagerPage.js';

const summaries: QueueSummary[] = [
  {
    driver: 'bullmq',
    queue: 'mail',
    isPaused: false,
    counts: { waiting: 2, active: 0, delayed: 0, failed: 1, completed: 9, paused: 0 },
  },
];

const waitingPage: JobPage = {
  jobs: [
    {
      id: '900',
      name: 'send-digest',
      state: 'waiting',
      attemptsMade: 0,
      maxAttempts: 3,
      timestamp: Date.now() - 1000,
      processedOn: null,
      finishedOn: null,
      failedReason: null,
      progress: null,
    },
  ],
  nextCursor: null,
  total: 1,
};

function mockClient(capabilities: QueueCapabilities): TelescopeClient {
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
    queueJobs: async () => waitingPage,
    queueJob: async () => null,
    queueJobAction: async () => ({ ok: true }),
    queueAction: async () => ({ ok: true }),
    queueEnqueue: async () => ({ id: null }),
  };
}

function renderPage(capabilities: QueueCapabilities) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <TelescopeProvider client={mockClient(capabilities)}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <QueueManagerPage />
        </MemoryRouter>
      </QueryClientProvider>
    </TelescopeProvider>,
  );
}

describe('QueueManagerPage', () => {
  it('renders the queue list, a state tab, and a job row', async () => {
    renderPage({ mutationsEnabled: false, actionsByDriver: {} });
    // queue list entry (in the sidebar)
    expect(await screen.findAllByText('mail')).toBeTruthy();
    // state tab label
    expect(screen.getByText('waiting')).toBeTruthy();
    // job row (auto-selected first queue, default 'waiting' state)
    expect(await screen.findByText('send-digest')).toBeTruthy();
  });

  it('hides job actions when mutationsEnabled is false', async () => {
    renderPage({ mutationsEnabled: false, actionsByDriver: { bullmq: ['retry', 'remove'] } });
    await screen.findByText('send-digest');
    // no per-row / drawer actions visible without opening, and retry-all only on failed tab
    expect(screen.queryByRole('button', { name: /retry all failed/i })).toBeNull();
  });
});
