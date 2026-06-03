import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { QueueCapabilities, TelescopeClient } from '../../../client/index.js';
import { TelescopeProvider } from '../../telescope-context.js';
import { EnqueueJobForm } from './EnqueueJobForm.js';

function mockClient(queueEnqueue: TelescopeClient['queueEnqueue']): TelescopeClient {
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
    queueAction: async () => ({ ok: true }),
    queueEnqueue,
  };
}

function renderForm(
  capabilities: QueueCapabilities,
  queueEnqueue: TelescopeClient['queueEnqueue'] = async () => ({ id: '1' }),
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <TelescopeProvider client={mockClient(queueEnqueue)}>
      <QueryClientProvider client={queryClient}>
        <EnqueueJobForm capabilities={capabilities} driver="bullmq" queue="mail" />
      </QueryClientProvider>
    </TelescopeProvider>,
  );
}

describe('EnqueueJobForm gating', () => {
  it('is hidden when the driver does not advertise enqueue', () => {
    renderForm({ mutationsEnabled: true, actionsByDriver: { bullmq: ['retry'] } });
    expect(screen.queryByRole('button', { name: /send message/i })).toBeNull();
  });

  it('is hidden when mutations are disabled even if enqueue is advertised', () => {
    renderForm({ mutationsEnabled: false, actionsByDriver: { bullmq: ['enqueue'] } });
    expect(screen.queryByRole('button', { name: /send message/i })).toBeNull();
  });

  it('is visible when enqueue is advertised and mutations are enabled', () => {
    renderForm({ mutationsEnabled: true, actionsByDriver: { bullmq: ['enqueue'] } });
    expect(screen.getByRole('button', { name: /send message/i })).toBeTruthy();
  });
});

describe('EnqueueJobForm submission', () => {
  const capabilities: QueueCapabilities = {
    mutationsEnabled: true,
    actionsByDriver: { bullmq: ['enqueue'] },
  };

  it('shows an inline error and does not call the client for invalid JSON', async () => {
    const queueEnqueue = vi.fn(async () => ({ id: '1' }));
    renderForm(capabilities, queueEnqueue);

    fireEvent.change(screen.getByLabelText(/payload/i), { target: { value: '{ not json' } });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    await waitFor(() => expect(screen.getByText(/valid json/i)).toBeTruthy());
    expect(queueEnqueue).not.toHaveBeenCalled();
  });

  it('parses the JSON payload and calls the client, then shows confirmation', async () => {
    const queueEnqueue = vi.fn(async () => ({ id: '42' }));
    renderForm(capabilities, queueEnqueue);

    fireEvent.change(screen.getByLabelText(/job name/i), { target: { value: 'send-email' } });
    fireEvent.change(screen.getByLabelText(/payload/i), {
      target: { value: '{"to":"a@b.c"}' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    await waitFor(() => expect(queueEnqueue).toHaveBeenCalledTimes(1));
    expect(queueEnqueue).toHaveBeenCalledWith('bullmq', 'mail', {
      name: 'send-email',
      payload: { to: 'a@b.c' },
    });
    await waitFor(() => expect(screen.getByText(/enqueued job 42/i)).toBeTruthy());
  });

  it('shows "Not authorized" inline when enqueue is forbidden (403)', async () => {
    const queueEnqueue = vi.fn(async () => {
      throw new Error('Request failed: 403');
    });
    renderForm(capabilities, queueEnqueue);

    fireEvent.change(screen.getByLabelText(/payload/i), { target: { value: '{"ok":true}' } });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    await waitFor(() => expect(screen.getByText(/not authorized/i)).toBeTruthy());
  });
});
