import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type {
  CursorPage,
  QueueCapabilities,
  QueueJob,
  QueueSummary,
  TelescopeClient,
} from '../../client/index.js';
import { TelescopeProvider } from '../../react/index.js';
import { LAST_PAGE_META, mockTelescopeClient } from '../../testing/mock-telescope-client.js';
import { QueueManagerPage } from './QueueManagerPage.js';

const summaries: QueueSummary[] = [
  {
    driver: 'bullmq',
    queue: 'mail',
    isPaused: false,
    counts: { waiting: 2, active: 0, delayed: 0, failed: 1, completed: 9, paused: 0 },
  },
];

const waitingPage: CursorPage<QueueJob> = {
  data: [
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
  meta: LAST_PAGE_META,
};

function mockClient(capabilities: QueueCapabilities): TelescopeClient {
  return mockTelescopeClient({
    entries: async () => ({ data: [], meta: LAST_PAGE_META }),
    meta: async () => ({
      enabled: true,
      droppedCount: 0,
      watchers: [],
      traceLink: null,
      retention: null,
      pruneEnabled: false,
      explainEnabled: false,
      sampling: {},
      tracesEnabled: true,
      ai: { enabled: false, mode: null },
      entryTypes: [],
      dashboards: [],
      profiling: { enabled: false, sampleRate: 0 },
    }),
    liveQueues: async () => ({ queues: summaries, capabilities }),
    queueCounts: async () => summaries[0]?.counts ?? ({} as never),
    queueJobs: async () => waitingPage,
    queueJob: async () => null,
    queueJobAction: async () => ({ ok: true }),
    queueAction: async () => ({ ok: true }),
    queueEnqueue: async () => ({ id: null }),
  });
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
    // Job row first: it only renders once the page has auto-selected the first queue
    // (an effect after the queue list arrives), so awaiting it means the selection —
    // and with it the state tabs — is in place. Asserting the tabs straight after the
    // sidebar entry appears raced that effect.
    expect(await screen.findByText('send-digest')).toBeTruthy();
    // queue list entry (in the sidebar) and the selected-queue heading
    expect(screen.getAllByText('mail').length).toBeGreaterThan(0);
    // state tab label
    expect(screen.getByText('waiting')).toBeTruthy();
  });

  it('hides job actions when mutationsEnabled is false', async () => {
    renderPage({ mutationsEnabled: false, actionsByDriver: { bullmq: ['retry', 'remove'] } });
    await screen.findByText('send-digest');
    // no per-row / drawer actions visible without opening, and retry-all only on failed tab
    expect(screen.queryByRole('button', { name: /retry all failed/i })).toBeNull();
  });
});
