import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { TelescopeClient } from '../../client/index.js';
import { TelescopeProvider } from '../../react/index.js';
import { ExportsPage } from './exports-page.js';

function mockClient(): TelescopeClient {
  const unused = async (): Promise<never> => {
    throw new Error('not used');
  };
  return {
    baseUrl: '',
    entries: async () => ({ data: [], nextCursor: null }),
    entry: unused,
    pulse: unused,
    queues: unused,
    timeseries: unused,
    traces: unused,
    waterfall: unused,
    stats: unused,
    tags: unused,
    meta: unused,
    extData: unused,
    serverStats: unused,
    serverStatsHistory: unused,
    health: unused,
    retention: unused,
    prunes: unused,
    prune: unused,
    explain: unused,
    diagnose: unused,
    cachedDiagnosis: unused,
    profilerStatus: unused,
    profiles: unused,
    profile: unused,
    armProfile: unused,
    liveQueues: unused,
    schedulesLive: unused,
    queueCounts: unused,
    queueJobs: unused,
    queueJob: unused,
    queueJobAction: unused,
    queueAction: unused,
    queueEnqueue: unused,
    auth: {
      me: unused,
      login: unused,
      logout: unused,
    },
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <TelescopeProvider client={mockClient()}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ExportsPage />
        </MemoryRouter>
      </QueryClientProvider>
    </TelescopeProvider>,
  );
}

describe('ExportsPage', () => {
  it('renders the export form with type, window, format and an export button', () => {
    renderPage();
    expect(screen.getByText('Export workbench')).toBeTruthy();
    expect(screen.getByText('Type')).toBeTruthy();
    expect(screen.getByText('Window')).toBeTruthy();
    expect(screen.getByText('Format')).toBeTruthy();
    expect(screen.getByText('Limit')).toBeTruthy();
    // Format is a listbox, not a native <select>: its options only exist once the popup is
    // open, so assert the trigger's current value rather than the options behind it.
    expect(screen.getByRole('combobox', { name: 'Export format' }).textContent).toContain('JSON');
    // the export action
    expect(screen.getByRole('button', { name: 'Export' })).toBeTruthy();
  });

  it('shows an empty state for the per-session recent exports list', () => {
    renderPage();
    expect(screen.getByText(/No exports yet/)).toBeTruthy();
  });
});
