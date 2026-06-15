import { cloneElement, isValidElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

vi.mock('recharts', async () => {
  const actual = await vi.importActual<typeof import('recharts')>('recharts');
  function Mock({ children }: { children: React.ReactNode }): JSX.Element {
    return (
      <div>{isValidElement(children) ? cloneElement(children, { width: 600, height: 300 }) : children}</div>
    );
  }
  return { ...actual, ResponsiveContainer: Mock };
});

vi.mock('../../react/use-telescope-queries.js', () => ({
  useMeta: () => ({
    data: {
      dashboards: [
        {
          id: 'demo.page',
          label: 'Demo',
          panels: [
            { kind: 'stat', title: 'Success rate', data: { provider: 'demo.rate' }, format: 'percent' },
          ],
        },
      ],
    },
  }),
  useExtensionData: () => ({ data: { value: 0.95 }, isError: false }),
}));

import { ExtensionDashboardPage } from './extension-dashboard-page.js';

describe('ExtensionDashboardPage', () => {
  it('renders panels from the meta dashboard spec', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/ext/demo.page']}>
          <Routes>
            <Route path="/ext/:dashboardId" element={<ExtensionDashboardPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('Success rate')).toBeTruthy());
    expect(screen.getByText('95%')).toBeTruthy();
  });
});
