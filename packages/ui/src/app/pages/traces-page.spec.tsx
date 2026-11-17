import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NuqsHashAdapter } from '../../aviary-kit/url-state/nuqs-hash-adapter';
import type { TelescopeClient, TraceSummary, TracesResult } from '../../client/index.js';
import { TelescopeProvider } from '../../react/index.js';
import { mockTelescopeClient } from '../../testing/mock-telescope-client.js';
import { settleUrlWrites } from '../settle-url.js';
import { TracesPage } from './traces-page.js';

afterEach(settleUrlWrites);

function trace(over: Partial<TraceSummary> & { traceId: string }): TraceSummary {
  return {
    entryCount: 1,
    types: ['request'],
    firstAt: '2026-06-03T12:00:00Z',
    lastAt: '2026-06-03T12:00:01Z',
    totalDurationMs: 42,
    ...over,
  };
}

function mockClient(rows: TraceSummary[]) {
  const traces = vi.fn<(window?: string, size?: number, after?: string) => Promise<TracesResult>>(
    async () => ({
      data: rows,
      scanned: rows.length,
      truncated: false,
    }),
  );
  const client: TelescopeClient = mockTelescopeClient({
    traces,
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
    queueJobAction: async () => ({ ok: true }),
    queueAction: async () => ({ ok: true }),
  });
  return { client, traces };
}

function renderPage(client: TelescopeClient, hash = '#/traces') {
  // The route goes to the router; the view state (`?window=`) is read from the real hash.
  window.history.replaceState(null, '', `/${hash}`);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <TelescopeProvider client={client}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/traces']}>
          <NuqsHashAdapter>
            <Routes>
              <Route path="/traces" element={<TracesPage />} />
              <Route path="/traces/:traceId" element={<div>trace detail</div>} />
            </Routes>
          </NuqsHashAdapter>
        </MemoryRouter>
      </QueryClientProvider>
    </TelescopeProvider>,
  );
}

describe('TracesPage', () => {
  it('reads the time window from the URL', async () => {
    const { client, traces } = mockClient([]);
    renderPage(client, '#/traces?window=24h');
    await waitFor(() => expect(traces.mock.calls[0]?.[0]).toBe('24h'));
    expect(screen.getByRole('combobox', { name: 'Time window' }).textContent).toContain('24h');
  });

  it('falls back to the default window for an unknown value', async () => {
    const { client, traces } = mockClient([]);
    renderPage(client, '#/traces?window=bogus');
    await waitFor(() => expect(traces.mock.calls[0]?.[0]).toBe('1h'));
  });

  it('renders a row per trace with label, dots, and entry count', async () => {
    const { client } = mockClient([
      trace({
        traceId: 't1',
        rootLabel: 'GET /users',
        types: ['cache', 'query', 'request'],
        entryCount: 3,
      }),
      trace({ traceId: 't2', entryCount: 1 }),
    ]);
    renderPage(client);

    expect(await screen.findByText('GET /users')).toBeTruthy();
    expect(screen.getByText('3 entries')).toBeTruthy();
    // falls back to the traceId when there's no rootLabel
    expect(screen.getByText('t2')).toBeTruthy();
    expect(screen.getByText('1 entry')).toBeTruthy();
    // a type dot per distinct type
    expect(screen.getByTitle('cache')).toBeTruthy();
    expect(screen.getByTitle('query')).toBeTruthy();
  });

  it('navigates to the per-trace page on row click', async () => {
    const { client } = mockClient([trace({ traceId: 'abc', rootLabel: 'POST /orders' })]);
    renderPage(client);

    const row = await screen.findByText('POST /orders');
    row.click();
    await waitFor(() => {
      expect(screen.getByText('trace detail')).toBeTruthy();
    });
  });

  it('pages older with the nextCursor, and back to the newer page', async () => {
    const { client, traces } = mockClient([]);
    traces.mockImplementation(async (_window, _size, after) =>
      after === undefined
        ? {
            data: [trace({ traceId: 'first' })],
            scanned: 1,
            truncated: false,
            nextCursor: 'c1',
            hasNext: true,
          }
        : {
            data: [trace({ traceId: 'second' })],
            scanned: 1,
            truncated: false,
            nextCursor: null,
            hasNext: false,
          },
    );
    renderPage(client);
    expect(await screen.findByText('first')).toBeTruthy();
    screen.getByLabelText('Older traces').click();
    expect(await screen.findByText('second')).toBeTruthy();
    expect(traces).toHaveBeenLastCalledWith('1h', undefined, 'c1');
    expect((screen.getByLabelText('Older traces') as HTMLButtonElement).disabled).toBe(true);
    screen.getByLabelText('Newer traces').click();
    expect(await screen.findByText('first')).toBeTruthy();
  });

  it('starts at the first page again when the window changes in the URL', async () => {
    const { client, traces } = mockClient([]);
    traces.mockImplementation(async (window, _size, after) => ({
      data: [trace({ traceId: `${window}-${after ?? 'first'}` })],
      scanned: 1,
      truncated: false,
      nextCursor: after === undefined ? 'c1' : null,
      hasNext: after === undefined,
    }));
    renderPage(client);
    expect(await screen.findByText('1h-first')).toBeTruthy();
    screen.getByLabelText('Older traces').click();
    expect(await screen.findByText('1h-c1')).toBeTruthy();
    // Back/forward or an edited link: the hash moves without the picker.
    window.location.hash = '#/traces?window=24h';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(await screen.findByText('24h-first')).toBeTruthy();
    const [lastWindow, , lastAfter] = traces.mock.calls.at(-1) ?? [];
    expect([lastWindow, lastAfter]).toEqual(['24h', undefined]);
  });

  it('shows no pager on a single page (or an older server without cursors)', async () => {
    const { client } = mockClient([trace({ traceId: 'only' })]);
    renderPage(client);
    expect(await screen.findByText('only')).toBeTruthy();
    expect(screen.queryByTestId('traces-pager')).toBeNull();
  });

  it('shows an empty state when there are no traces', async () => {
    const { client } = mockClient([]);
    renderPage(client);

    expect(await screen.findByText('No traces in this window')).toBeTruthy();
  });
});
