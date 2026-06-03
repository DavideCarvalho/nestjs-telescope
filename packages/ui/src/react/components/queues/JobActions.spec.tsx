import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { QueueCapabilities, QueueState, TelescopeClient } from '../../../client/index.js';
import { TelescopeProvider } from '../../telescope-context.js';
import { JobActions, jobActionAllowedForState, supportsAction } from './JobActions.js';

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
  };
}

function renderActions(capabilities: QueueCapabilities, state: QueueState) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <TelescopeProvider client={mockClient()}>
      <QueryClientProvider client={queryClient}>
        <JobActions capabilities={capabilities} driver="bullmq" queue="mail" id="1" state={state} />
      </QueryClientProvider>
    </TelescopeProvider>,
  );
}

const ALL_ACTIONS: QueueCapabilities = {
  mutationsEnabled: true,
  actionsByDriver: { bullmq: ['retry', 'remove', 'promote', 'retry-all'] },
};

describe('supportsAction', () => {
  it('is false when mutations are disabled even if the action is advertised', () => {
    expect(
      supportsAction(
        { mutationsEnabled: false, actionsByDriver: { bullmq: ['retry'] } },
        'bullmq',
        'retry',
      ),
    ).toBe(false);
  });
  it('is false when the action is not advertised for the driver', () => {
    expect(
      supportsAction(
        { mutationsEnabled: true, actionsByDriver: { bullmq: ['remove'] } },
        'bullmq',
        'retry',
      ),
    ).toBe(false);
  });
  it('is true when enabled and advertised', () => {
    expect(supportsAction(ALL_ACTIONS, 'bullmq', 'retry')).toBe(true);
  });
});

describe('jobActionAllowedForState', () => {
  it('only allows promote on delayed jobs', () => {
    expect(jobActionAllowedForState('promote', 'delayed')).toBe(true);
    expect(jobActionAllowedForState('promote', 'failed')).toBe(false);
  });
  it('only allows retry on failed/completed jobs', () => {
    expect(jobActionAllowedForState('retry', 'failed')).toBe(true);
    expect(jobActionAllowedForState('retry', 'completed')).toBe(true);
    expect(jobActionAllowedForState('retry', 'waiting')).toBe(false);
  });
  it('always allows remove', () => {
    expect(jobActionAllowedForState('remove', 'waiting')).toBe(true);
  });
});

describe('JobActions gating', () => {
  it('hides all buttons when mutationsEnabled is false', () => {
    renderActions(
      { mutationsEnabled: false, actionsByDriver: { bullmq: ['retry', 'remove', 'promote'] } },
      'failed',
    );
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /promote/i })).toBeNull();
  });

  it('hides an action that is not in actionsByDriver', () => {
    renderActions({ mutationsEnabled: true, actionsByDriver: { bullmq: ['remove'] } }, 'failed');
    // remove is advertised → visible; retry is not advertised → hidden
    expect(screen.getByRole('button', { name: /remove/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('shows retry + remove on a failed job when both hold', () => {
    renderActions(ALL_ACTIONS, 'failed');
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /remove/i })).toBeTruthy();
    // promote is supported but the job is failed, not delayed → hidden
    expect(screen.queryByRole('button', { name: /promote/i })).toBeNull();
  });

  it('shows promote only when the job is delayed', () => {
    renderActions(ALL_ACTIONS, 'delayed');
    expect(screen.getByRole('button', { name: /promote/i })).toBeTruthy();
    // retry not valid for delayed
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
});
