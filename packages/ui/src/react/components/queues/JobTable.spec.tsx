import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { JobPage, QueueJob, TelescopeClient } from '../../../client/index.js';
import { TelescopeProvider } from '../../telescope-context.js';
import { JobTable } from './JobTable.js';

const jobs: QueueJob[] = [
  {
    id: '101',
    name: 'send-welcome',
    state: 'failed',
    attemptsMade: 2,
    maxAttempts: 3,
    timestamp: Date.now() - 5000,
    processedOn: null,
    finishedOn: null,
    failedReason: 'SMTP connection refused',
    progress: null,
  },
  {
    id: '102',
    name: 'send-receipt',
    state: 'failed',
    attemptsMade: 1,
    maxAttempts: 3,
    timestamp: Date.now() - 60000,
    processedOn: null,
    finishedOn: null,
    failedReason: null,
    progress: null,
  },
];

const page: JobPage = { jobs, nextCursor: null, total: 2 };

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
    meta: async () => ({ enabled: true, droppedCount: 0, watchers: [] }),
    liveQueues: async () => ({
      queues: [],
      capabilities: { mutationsEnabled: false, actionsByDriver: {} },
    }),
    queueCounts: async () => ({
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 2,
      completed: 0,
      paused: 0,
    }),
    queueJobs: async () => page,
    queueJob: async () => null,
    queueJobAction: async () => ({ ok: true }),
    queueAction: async () => ({ ok: true }),
  };
}

describe('JobTable', () => {
  it('renders job rows with id, name, attempts and failed reason', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <TelescopeProvider client={mockClient()}>
        <QueryClientProvider client={queryClient}>
          <JobTable driver="bullmq" queue="mail" state="failed" onOpen={() => {}} />
        </QueryClientProvider>
      </TelescopeProvider>,
    );
    expect(await screen.findByText('send-welcome')).toBeTruthy();
    expect(screen.getByText('send-receipt')).toBeTruthy();
    expect(screen.getByText('2/3')).toBeTruthy();
    expect(screen.getByText('SMTP connection refused')).toBeTruthy();
  });
});
