import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { PrunesInfo, TelescopeClient } from '../../client/index.js';
import { TelescopeProvider } from '../../react/index.js';
import { DashboardLayout } from '../dashboard-layout.js';
import { ThemeProvider } from '../theme-context.js';
import { PrunesPage } from './prunes-page.js';

const PRUNES: PrunesInfo = {
  config: {
    afterMs: 3_600_000,
    intervalMs: 60_000,
    keepLast: 100,
    perType: { exception: 604_800_000 },
  },
  nextRunAt: new Date(Date.now() + 30_000).toISOString(),
  runs: [
    {
      at: new Date(Date.now() - 4000).toISOString(),
      trigger: 'scheduled',
      durationMs: 1234,
      deletedTotal: 5,
      deletedByType: { exception: 3 },
      archivedTotal: 2,
    },
    {
      at: new Date(Date.now() - 9000).toISOString(),
      trigger: 'manual',
      durationMs: 50,
      deletedTotal: 0,
      deletedByType: {},
      error: 'boom',
    },
  ],
};

function mockClient(prunes: PrunesInfo, pruneEnabled: boolean): TelescopeClient {
  return {
    meta: async () => ({
      enabled: true,
      droppedCount: 0,
      watchers: [],
      traceLink: null,
      retention: { afterMs: 3_600_000, keepLast: 100 },
      pruneEnabled,
      sampling: {},
    }),
    prunes: async () => prunes,
    prune: async () => ({ pruned: 0 }),
    entries: async () => ({ data: [], nextCursor: null }),
    schedulesLive: async () => ({ tasks: [] }),
    liveQueues: async () => ({
      queues: [],
      capabilities: { mutationsEnabled: false, actionsByDriver: {} },
    }),
  };
}

function renderPage(prunes: PrunesInfo, pruneEnabled = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <TelescopeProvider client={mockClient(prunes, pruneEnabled)}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <PrunesPage />
        </MemoryRouter>
      </QueryClientProvider>
    </TelescopeProvider>,
  );
}

describe('PrunesPage', () => {
  it('renders recorded runs with totals, per-type chips and config cards', async () => {
    renderPage(PRUNES);
    expect(await screen.findByText('scheduled')).toBeTruthy();
    expect(screen.getByText('manual')).toBeTruthy();
    // total deleted for the scheduled run
    expect(screen.getByText('5')).toBeTruthy();
    // per-type chip: exception → 3 (Exceptions label from entry-types). The label
    // also appears in the per-type override config card, hence getAllByText.
    expect(screen.getAllByText('Exceptions').length).toBeGreaterThan(0);
    expect(screen.getByText('3')).toBeTruthy();
    // config window card uses the retention formatter
    expect(screen.getByText('Window')).toBeTruthy();
    // per-run error surfaced
    expect(screen.getByText('boom')).toBeTruthy();
  });

  it('enables "Prune now" when mutations are enabled', async () => {
    renderPage(PRUNES, true);
    const button = await screen.findByRole('button', { name: /Prune now/ });
    // The button starts disabled until the meta query resolves pruneEnabled.
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
  });

  it('disables "Prune now" with a hint when mutations are disabled', async () => {
    renderPage(PRUNES, false);
    const button = await screen.findByRole('button', { name: /Prune now/ });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('title')).toMatch(/Mutations are disabled/);
  });

  it('shows an empty state when no runs are recorded yet', async () => {
    renderPage({ ...PRUNES, runs: [] });
    expect(await screen.findByText(/No prune runs recorded yet on this pod/)).toBeTruthy();
  });
});

describe('dashboard nav', () => {
  it('includes Prunes and Exports console links', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ThemeProvider>
        <TelescopeProvider client={mockClient(PRUNES, true)}>
          <QueryClientProvider client={queryClient}>
            <MemoryRouter>
              <DashboardLayout>{null}</DashboardLayout>
            </MemoryRouter>
          </QueryClientProvider>
        </TelescopeProvider>
      </ThemeProvider>,
    );
    expect(screen.getByRole('link', { name: 'Prunes' }).getAttribute('href')).toBe('/prunes');
    expect(screen.getByRole('link', { name: 'Exports' }).getAttribute('href')).toBe('/exports');
  });
});
