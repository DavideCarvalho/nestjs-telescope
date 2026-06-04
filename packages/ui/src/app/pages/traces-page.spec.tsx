import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { TelescopeClient, TraceSummary, TracesResult } from '../../client/index.js';
import { TelescopeProvider } from '../../react/index.js';
import { TracesPage } from './traces-page.js';

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
  const traces = vi.fn<(window?: string, limit?: number) => Promise<TracesResult>>(async () => ({
    traces: rows,
    scanned: rows.length,
    truncated: false,
  }));
  const notUsed = async () => {
    throw new Error('not used');
  };
  const client: TelescopeClient = {
    entries: notUsed,
    entry: notUsed,
    pulse: notUsed,
    queues: notUsed,
    timeseries: notUsed,
    traces,
    stats: notUsed,
    meta: async () => ({
      enabled: true,
      droppedCount: 0,
      watchers: [],
      traceLink: null,
      retention: null,
      sampling: {},
    }),
    liveQueues: notUsed,
    queueCounts: notUsed,
    queueJobs: notUsed,
    queueJob: notUsed,
    queueJobAction: async () => ({ ok: true }),
    queueAction: async () => ({ ok: true }),
  };
  return { client, traces };
}

function renderPage(client: TelescopeClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <TelescopeProvider client={client}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/traces']}>
          <Routes>
            <Route path="/traces" element={<TracesPage />} />
            <Route path="/traces/:traceId" element={<div>trace detail</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </TelescopeProvider>,
  );
}

describe('TracesPage', () => {
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

  it('shows an empty state when there are no traces', async () => {
    const { client } = mockClient([]);
    renderPage(client);

    expect(await screen.findByText('No traces in this window')).toBeTruthy();
  });
});
