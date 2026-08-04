import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { cloneElement, isValidElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fixed-size ResponsiveContainer, as in the sibling page spec: without it the
// charts render no bars and there is nothing to click.
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

const { useExtensionDataMock } = vi.hoisted(() => ({ useExtensionDataMock: vi.fn() }));

/**
 * Two dashboards: one whose topN panel declares `drilldown`, one identical panel
 * that does not. The pair is the point — the second is the regression guard that
 * an extension shipping today does not start filtering itself.
 */
vi.mock('../../react/use-telescope-queries.js', () => ({
  useMeta: () => ({
    data: {
      dashboards: [
        {
          id: 'demo.drill',
          label: 'Drillable',
          panels: [
            {
              kind: 'topN',
              title: 'Busiest workflows',
              data: { provider: 'wf.top' },
              drilldown: { param: 'workflow' },
            },
            { kind: 'stat', title: 'Failures', data: { provider: 'wf.failures' } },
          ],
        },
        {
          id: 'demo.inert',
          label: 'Inert',
          panels: [{ kind: 'topN', title: 'Busiest workflows', data: { provider: 'wf.top' } }],
        },
      ],
    },
  }),
  useExtensionData: useExtensionDataMock,
}));

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

function queriesFor(provider: string): Array<Record<string, unknown> | undefined> {
  return useExtensionDataMock.mock.calls
    .filter((call) => call[1] === provider)
    .map((call) => call[2]);
}

function bars(): NodeListOf<Element> {
  return document.querySelectorAll('.recharts-bar-rectangle');
}

describe('ExtensionDashboardPage drill-down', () => {
  beforeEach(() => {
    useExtensionDataMock.mockReset();
    useExtensionDataMock.mockImplementation((_ext: string, provider: string) => {
      if (provider === 'wf.top') {
        return {
          data: {
            items: [
              { label: 'checkout', value: 12, id: 'wf_checkout' },
              { label: 'refund', value: 4, id: 'wf_refund' },
            ],
          },
          isError: false,
        };
      }
      return { data: { value: 3 }, isError: false };
    });
  });

  it('turns a bar click into a query param on EVERY panel, and says so in a chip', async () => {
    renderPage('demo.drill');
    await waitFor(() => expect(bars().length).toBe(2));

    const refund = bars()[1];
    if (refund) fireEvent.click(refund);

    // The datum's `id` wins over its label: a provider that bothered to give the
    // item a stable id is telling you what to filter on.
    await waitFor(() => {
      expect(queriesFor('wf.failures').at(-1)).toEqual({ workflow: 'wf_refund' });
    });
    expect(queriesFor('wf.top').at(-1)).toEqual({ workflow: 'wf_refund' });
    expect(screen.getByText(/workflow: refund/)).toBeTruthy();
  });

  it('clears the selection from the chip', async () => {
    renderPage('demo.drill');
    await waitFor(() => expect(bars().length).toBe(2));
    const checkout = bars()[0];
    if (checkout) fireEvent.click(checkout);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull());
    expect(queriesFor('wf.failures').at(-1)).toBeUndefined();
  });

  it('clicking the same bar twice is the way back out', async () => {
    renderPage('demo.drill');
    await waitFor(() => expect(bars().length).toBe(2));
    const checkout = () => bars()[0];
    const first = checkout();
    if (first) fireEvent.click(first);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy());
    const second = checkout();
    if (second) fireEvent.click(second);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull());
  });

  it('leaves a panel with no drilldown inert — no handler, no query change', async () => {
    renderPage('demo.inert');
    await waitFor(() => expect(bars().length).toBe(2));
    const bar = bars()[0];
    if (bar) fireEvent.click(bar);

    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    for (const query of queriesFor('wf.top')) expect(query).toBeUndefined();
  });
});
