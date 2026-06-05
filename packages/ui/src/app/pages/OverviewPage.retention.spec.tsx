import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelescopeClient, TelescopeMeta } from '../../client/index.js';
import { TelescopeProvider } from '../../react/index.js';
import { OverviewPage } from './OverviewPage.js';

const EMPTY_PULSE = {
  windowStart: '',
  windowEnd: '',
  windowMs: 3_600_000,
  scanned: 0,
  truncated: false,
  counts: {},
  slowest: [],
  topExceptions: [],
  nPlusOne: [],
  slowRoutes: [],
  slowOutgoing: [],
};

const EMPTY_QUEUES = {
  windowStart: '',
  windowEnd: '',
  windowMs: 3_600_000,
  scanned: 0,
  truncated: false,
  queues: [],
};

const EMPTY_SERIES = {
  windowStart: '',
  windowEnd: '',
  bucketMs: 60_000,
  scanned: 0,
  truncated: false,
  buckets: [],
};

function baseMeta(pruneEnabled: boolean): TelescopeMeta {
  return {
    enabled: true,
    droppedCount: 0,
    watchers: [],
    traceLink: null,
    retention: { afterMs: 3_600_000, keepLast: null },
    pruneEnabled,
    explainEnabled: false,
    sampling: {},
  };
}

function mockClient(pruneEnabled: boolean, prune: () => Promise<{ pruned: number }>) {
  return {
    entries: async () => ({ data: [], nextCursor: null }),
    entry: async () => {
      throw new Error('not used');
    },
    pulse: async () => EMPTY_PULSE,
    queues: async () => EMPTY_QUEUES,
    timeseries: async () => EMPTY_SERIES,
    stats: async () => {
      throw new Error('not used');
    },
    meta: async () => baseMeta(pruneEnabled),
    serverStats: async () => ({
      uptimeSec: 1,
      memory: { rssMb: 1, heapUsedMb: 1, heapTotalMb: 1 },
      cpu: { userMs: 0, systemMs: 0 },
      eventLoopDelayMs: 0,
      instanceId: 'i',
    }),
    health: async () => ({
      enabled: true,
      recorded: 0,
      bufferSize: 1,
      bufferUsed: 0,
      bufferHighWater: 0,
      flushes: 0,
      flushedEntries: 0,
      lastFlushMs: null,
      maxFlushMs: null,
      totalFlushMs: 0,
      overflowDropped: 0,
      storeFailedDropped: 0,
      droppedCount: 0,
      truncatedCount: 0,
      captureCostNanos: 1,
    }),
    retention: async () => ({
      retention: { afterMs: 3_600_000, keepLast: null },
      entryCount: null,
      oldestCreatedAt: null,
      pruneSupported: true as const,
    }),
    prune,
  } as unknown as TelescopeClient;
}

function renderOverview(pruneEnabled: boolean, prune: () => Promise<{ pruned: number }>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <TelescopeProvider client={mockClient(pruneEnabled, prune)}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <OverviewPage />
        </MemoryRouter>
      </QueryClientProvider>
    </TelescopeProvider>,
  );
}

describe('OverviewPage retention card', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    vi.spyOn(globalThis, 'alert').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the retention window and shows the Prune now button when enabled', async () => {
    renderOverview(true, async () => ({ pruned: 0 }));
    expect(await screen.findByText('Retention')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Prune now' })).toBeTruthy();
    });
  });

  it('hides the Prune now button when mutations are not enabled', async () => {
    renderOverview(false, async () => ({ pruned: 0 }));
    expect(await screen.findByText('Retention')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Prune now' })).toBeNull();
    });
  });

  it('confirms, prunes, and reports the count on click', async () => {
    const prune = vi.fn(async () => ({ pruned: 3 }));
    renderOverview(true, prune);
    const button = await screen.findByRole('button', { name: 'Prune now' });
    fireEvent.click(button);
    await waitFor(() => {
      expect(prune).toHaveBeenCalledTimes(1);
    });
    expect(globalThis.confirm).toHaveBeenCalled();
    expect(globalThis.alert).toHaveBeenCalledWith('Pruned 3 entries.');
  });

  it('does not prune when the confirm is dismissed', async () => {
    vi.spyOn(globalThis, 'confirm').mockReturnValue(false);
    const prune = vi.fn(async () => ({ pruned: 1 }));
    renderOverview(true, prune);
    const button = await screen.findByRole('button', { name: 'Prune now' });
    fireEvent.click(button);
    expect(prune).not.toHaveBeenCalled();
  });
});
