import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { QueueCapabilities, TelescopeClient } from '../../../client/index.js';
import { TelescopeProvider } from '../../telescope-context.js';
import { RedriveDlqButton } from './JobActions.js';

function mockClient(queueAction: TelescopeClient['queueAction']): TelescopeClient {
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
      failed: 0,
      completed: 0,
      paused: 0,
    }),
    queueJobs: async () => ({ jobs: [], nextCursor: null, total: 0 }),
    queueJob: async () => null,
    queueJobAction: async () => ({ ok: true }),
    queueAction,
  };
}

function renderButton(
  capabilities: QueueCapabilities,
  queueAction: TelescopeClient['queueAction'] = async () => ({ ok: true }),
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <TelescopeProvider client={mockClient(queueAction)}>
      <QueryClientProvider client={queryClient}>
        <RedriveDlqButton capabilities={capabilities} driver="sqs" queue="mail" />
      </QueryClientProvider>
    </TelescopeProvider>,
  );
}

describe('RedriveDlqButton gating', () => {
  it('is hidden when the driver does not advertise redrive', () => {
    renderButton({ mutationsEnabled: true, actionsByDriver: { sqs: ['retry-all'] } });
    expect(screen.queryByRole('button', { name: /redrive/i })).toBeNull();
  });

  it('is hidden when mutations are disabled even if redrive is advertised', () => {
    renderButton({ mutationsEnabled: false, actionsByDriver: { sqs: ['redrive'] } });
    expect(screen.queryByRole('button', { name: /redrive/i })).toBeNull();
  });

  it('is visible when redrive is advertised and mutations are enabled', () => {
    renderButton({ mutationsEnabled: true, actionsByDriver: { sqs: ['redrive'] } });
    expect(screen.getByRole('button', { name: /redrive dlq/i })).toBeTruthy();
  });

  it('confirms before firing and calls queueAction with action "redrive"', async () => {
    const queueAction = vi.fn(async () => ({ ok: true }));
    renderButton({ mutationsEnabled: true, actionsByDriver: { sqs: ['redrive'] } }, queueAction);

    // First click only arms the confirmation — no mutation yet.
    fireEvent.click(screen.getByRole('button', { name: /redrive dlq/i }));
    expect(queueAction).not.toHaveBeenCalled();

    // Confirm fires the mutation.
    fireEvent.click(screen.getByRole('button', { name: /confirm redrive/i }));
    await waitFor(() => expect(queueAction).toHaveBeenCalledTimes(1));
    expect(queueAction).toHaveBeenCalledWith('sqs', 'mail', 'redrive', {});
  });

  it('shows "Not authorized" inline when the action is forbidden (403)', async () => {
    const queueAction = vi.fn(async () => {
      throw new Error('Request failed: 403');
    });
    renderButton({ mutationsEnabled: true, actionsByDriver: { sqs: ['redrive'] } }, queueAction);

    fireEvent.click(screen.getByRole('button', { name: /redrive dlq/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm redrive/i }));

    await waitFor(() => expect(screen.getByText(/not authorized/i)).toBeTruthy());
  });
});
