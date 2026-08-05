import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { cloneElement, isValidElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

// `useExtensionData` is a `vi.fn()` (via `vi.hoisted` so it's reachable both inside
// the mock factory below and from test bodies) so the paged-table round-trip test
// can inspect exactly what `query` each resolve call carried.
const { useExtensionDataMock } = vi.hoisted(() => ({ useExtensionDataMock: vi.fn() }));

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
            {
              title: 'Wide',
              cols: 1,
              panels: [
                {
                  kind: 'stat',
                  title: 'Full width panel',
                  data: { provider: 'jobs.wide' },
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
        {
          id: 'demo.paged',
          label: 'Paged Demo',
          panels: [
            {
              kind: 'table',
              title: 'Runs',
              data: { provider: 'runs.list' },
              columns: [{ key: 'runId', label: 'Run' }],
              paged: true,
            },
          ],
        },
        {
          id: 'demo.sortable',
          label: 'Sortable Demo',
          panels: [
            {
              kind: 'table',
              title: 'Runs',
              data: { provider: 'runs.list', query: { window: '24h' } },
              columns: [{ key: 'runId', label: 'Run', sortable: true, filterable: true }],
              paged: true,
            },
          ],
        },
      ],
    },
  }),
  useExtensionData: useExtensionDataMock,
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
  beforeEach(() => {
    useExtensionDataMock.mockReset();
    useExtensionDataMock.mockImplementation(
      (_ext: string, provider: string, query?: Record<string, unknown>) => {
        if (provider === 'runs.list') {
          const page = typeof query?.page === 'number' ? query.page : 1;
          const limit = typeof query?.limit === 'number' ? query.limit : 50;
          return {
            data: { rows: [{ runId: `r${page}` }], total: 120, page, limit },
            isError: false,
          };
        }
        return { data: { value: 42 }, isError: false };
      },
    );
  });

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

  // `cols: 1` is the full-width row. A section is a fixed `grid-cols-N` with no `colSpan`, so
  // before it existed the widest panel a dashboard has could only be declared in a 2-column grid,
  // where it took half the viewport and left a hole beside it. The grid is already `grid-cols-1`
  // at every breakpoint, so a full-width row is the absence of a responsive override — assert that
  // rather than the presence of a class, since adding `md:grid-cols-1` would be the bug.
  it('gives a cols:1 section a full-width row, with no responsive column override', async () => {
    const { container } = renderPage('demo.page');
    await waitFor(() => expect(screen.getByText('Wide')).toBeTruthy());

    const gridOf = (title: string) => {
      const heading = [...container.querySelectorAll('section')].find((s) =>
        s.textContent?.startsWith(title),
      );
      return heading?.querySelector('div.grid')?.className ?? '';
    };

    expect(gridOf('Wide')).toContain('grid-cols-1');
    expect(gridOf('Wide')).not.toMatch(/md:grid-cols-|lg:grid-cols-/);
    // The sections beside it still get theirs, so this is not "the override stopped working".
    expect(gridOf('Trends')).toContain('md:grid-cols-2');
    expect(gridOf('Health')).toContain('lg:grid-cols-4');
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

  it('paged table: clicking Next re-resolves the provider with query.page/query.limit', async () => {
    renderPage('demo.paged');
    await waitFor(() => {
      expect(screen.getByText('r1')).toBeTruthy();
    });
    // First resolve carries no page — BoundPanel's own state seeds it (page 1).
    const [, firstProvider, firstQuery] = useExtensionDataMock.mock.calls[0] ?? [];
    expect(firstProvider).toBe('runs.list');
    expect((firstQuery as Record<string, unknown> | undefined)?.page).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(screen.getByText('r2')).toBeTruthy();
    });

    const lastCall = useExtensionDataMock.mock.calls.at(-1) ?? [];
    const [, lastProvider, lastQuery] = lastCall;
    expect(lastProvider).toBe('runs.list');
    const query = lastQuery as Record<string, unknown> | undefined;
    expect(query?.page).toBe(2);
    expect(query?.limit).toBe(50);
  });

  it('non-paged tables never carry page/limit in their resolve query', async () => {
    renderPage('demo.flat');
    await waitFor(() => {
      expect(screen.getByText('Flat Dashboard')).toBeTruthy();
    });
    const flatCall = useExtensionDataMock.mock.calls.find((call) => call[1] === 'flat.provider');
    expect(flatCall?.[2]).toBeUndefined();
  });

  describe('server-side sort and filter', () => {
    /** The query the most recent resolve of `runs.list` carried. */
    function lastQuery(): Record<string, unknown> | undefined {
      const call = useExtensionDataMock.mock.calls.at(-1) ?? [];
      const query = call[2];
      return typeof query === 'object' && query !== null ? query : undefined;
    }

    it('a table with no sortable column resolves exactly the query it always did', async () => {
      // The compatibility guarantee for every dashboard a sibling library has
      // already shipped: no new params appear unless a column asked for them.
      renderPage('demo.paged');
      await waitFor(() => {
        expect(screen.getByText('r1')).toBeTruthy();
      });
      expect(lastQuery()).toEqual({ page: 1, limit: 50 });
    });

    it('clicking a sortable header re-resolves the provider with `sort` + `dir`', async () => {
      renderPage('demo.sortable');
      await waitFor(() => {
        expect(screen.getByText('r1')).toBeTruthy();
      });
      // The panel's own static query survives the merge — it is the scope the
      // extension author declared, not something the table may drop.
      expect(lastQuery()).toEqual({ window: '24h', page: 1, limit: 50 });

      fireEvent.click(screen.getByRole('button', { name: /Run/ }));
      await waitFor(() => {
        expect(lastQuery()).toEqual({
          window: '24h',
          page: 1,
          limit: 50,
          sort: 'runId',
          dir: 'asc',
        });
      });
    });

    it('committing a filter re-resolves with a `filter.`-namespaced param', async () => {
      renderPage('demo.sortable');
      await waitFor(() => {
        expect(screen.getByText('r1')).toBeTruthy();
      });
      const box = screen.getByLabelText('Filter by runId');
      fireEvent.change(box, { target: { value: 'checkout' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      await waitFor(() => {
        expect(lastQuery()?.['filter.runId']).toBe('checkout');
      });
    });

    it('returns to page 1 when the sort changes', async () => {
      // "Page 4 of the runs sorted by id" has no counterpart in a differently
      // sorted result set, and landing past the end of a shorter one is a table
      // that looks empty for no visible reason.
      renderPage('demo.sortable');
      await waitFor(() => {
        expect(screen.getByText('r1')).toBeTruthy();
      });
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      await waitFor(() => {
        expect(lastQuery()?.page).toBe(2);
      });
      fireEvent.click(screen.getByRole('button', { name: /Run/ }));
      await waitFor(() => {
        expect(lastQuery()?.page).toBe(1);
      });
    });
  });
});
