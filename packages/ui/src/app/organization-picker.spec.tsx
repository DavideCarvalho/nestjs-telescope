import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { HashRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { ConsoleTenancyInfo } from '../client/index.js';
import { TelescopeProvider } from '../react/index.js';
import { mockTelescopeClient } from '../testing/mock-telescope-client.js';
import { DashboardLayout } from './dashboard-layout.js';
import { ThemeProvider } from './theme-context.js';

function renderWith(info: ConsoleTenancyInfo) {
  const client = mockTelescopeClient({
    entries: async () => ({ data: [], nextCursor: null }),
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
    retention: async () => ({
      retention: null,
      entryCount: null,
      oldestCreatedAt: null,
      pruneSupported: true,
    }),
    tenancy: async () => info,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider>
      <TelescopeProvider client={client}>
        <QueryClientProvider client={queryClient}>
          <HashRouter>
            <DashboardLayout>
              <div>child</div>
            </DashboardLayout>
          </HashRouter>
        </QueryClientProvider>
      </TelescopeProvider>
    </ThemeProvider>,
  );
}

describe('Organization control', () => {
  it('is absent with tenancy off', async () => {
    renderWith({ enabled: false });
    expect(await screen.findByText('child')).toBeTruthy();
    expect(screen.queryByText(/Organization:/)).toBeNull();
  });

  it('one organization: a fixed chip', async () => {
    renderWith({
      enabled: true,
      tenants: ['A'],
      selected: 'A',
      options: [{ id: 'A', label: 'acme' }],
    });
    expect(await screen.findByText('acme')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Organization/ })).toBeNull();
  });

  it('none: the console asks to choose an organization', async () => {
    renderWith({ enabled: true, tenants: [], selected: null, options: [] });
    expect(await screen.findByText('Choose an organization to see its data.')).toBeTruthy();
    expect(screen.queryByText('child')).toBeNull();
  });

  it('several organizations and none selected: never claims all of them', async () => {
    renderWith({
      enabled: true,
      tenants: ['A', 'B'],
      selected: null,
      options: [
        { id: 'A', label: 'A' },
        { id: 'B', label: 'B' },
      ],
    });
    expect(await screen.findByRole('button', { name: /Organization: none/ })).toBeTruthy();
    expect(screen.queryByText('All organizations')).toBeNull();
  });

  it("'*': a picker with All organizations first", async () => {
    renderWith({
      enabled: true,
      tenants: '*',
      selected: null,
      options: [
        { id: 'A', label: 'A' },
        { id: 'B', label: 'B' },
      ],
    });
    fireEvent.click(await screen.findByRole('button', { name: /All organizations/ }));
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['All organizations', 'A', 'B']);
  });
});
