import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { cloneElement, isValidElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('recharts', async () => {
  const actual = await vi.importActual<typeof import('recharts')>('recharts');
  function Mock({ children }: { children: React.ReactNode }): JSX.Element {
    return (
      <div>
        {isValidElement(children) ? cloneElement(children, { width: 600, height: 300 }) : children}
      </div>
    );
  }
  return { ...actual, ResponsiveContainer: Mock };
});

// Mock the queries module for sectioned dashboard
vi.mock('../../react/use-telescope-queries.js', () => ({
  useMeta: () => ({
    data: {
      dashboards: [
        {
          id: 'demo.page',
          label: 'Demo',
          panels: [],
          sections: [
            {
              title: 'Health',
              cols: 4,
              panels: [
                {
                  kind: 'stat',
                  title: 'Active jobs',
                  data: { provider: 'jobs.active' },
                },
              ],
            },
            {
              title: 'Trends',
              cols: 2,
              panels: [
                {
                  kind: 'stat',
                  title: 'Throughput',
                  data: { provider: 'jobs.throughput' },
                },
              ],
            },
          ],
        },
        {
          id: 'demo.flat',
          label: 'Flat Dashboard',
          panels: [
            {
              kind: 'stat',
              title: 'Flat Panel',
              data: { provider: 'flat.provider' },
            },
          ],
        },
      ],
    },
  }),
  useExtensionData: () => ({ data: { value: 42 }, isError: false }),
}));

// Mock the stream hook — jsdom has no EventSource, so the real hook returns 'polling'
// but some environments may not define EventSource at all; avoid any fetch.
vi.mock('../../react/use-telescope-stream.js', () => ({
  useTelescopeStream: () => ({ status: 'polling' }),
}));

import { ExtensionDashboardPage } from './extension-dashboard-page.js';

function renderPage(dashboardId: string) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={[`/ext/${dashboardId}`]}>
        <Routes>
          <Route path="/ext/:dashboardId" element={<ExtensionDashboardPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ExtensionDashboardPage', () => {
  it('renders section titles for dashboards with sections', async () => {
    renderPage('demo.page');
    await waitFor(() => {
      expect(screen.getByText('Health')).toBeTruthy();
      expect(screen.getByText('Trends')).toBeTruthy();
    });
  });

  it('renders the dashboard label in the header', async () => {
    renderPage('demo.page');
    await waitFor(() => {
      expect(screen.getByText('Demo')).toBeTruthy();
    });
  });

  it('renders flat-panels dashboards (backward compat: no sections)', async () => {
    renderPage('demo.flat');
    await waitFor(() => {
      expect(screen.getByText('Flat Dashboard')).toBeTruthy();
    });
  });

  it('renders the status badge', async () => {
    renderPage('demo.page');
    await waitFor(() => {
      const badge = document.querySelector('[data-telescope-status]');
      expect(badge).not.toBeNull();
      expect(badge?.getAttribute('data-telescope-status')).toBe('polling');
    });
  });

  it('shows "not found" for an unknown dashboard id', () => {
    renderPage('unknown.page');
    expect(screen.getByText('Dashboard not found.')).toBeTruthy();
  });
});
