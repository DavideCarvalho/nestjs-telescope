import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { EntriesQuery, Entry, Page, TelescopeClient } from '../../client/index.js';
import { TelescopeProvider } from '../../react/index.js';
import { TracePage } from './trace-page.js';

function entry(over: Partial<Entry> & { type: string; id: string }): Entry {
  return {
    batchId: 'b',
    familyHash: null,
    content: {},
    tags: [],
    sequence: 0,
    durationMs: 12,
    origin: 'http',
    instanceId: 'i',
    traceId: 'trace-1',
    spanId: null,
    createdAt: '2026-06-03T12:00:00Z',
    ...over,
  };
}

function mockClient(rows: Entry[]) {
  const entries = vi.fn<(query?: EntriesQuery) => Promise<Page<Entry>>>(async () => ({
    data: rows,
    nextCursor: null,
  }));
  const client: TelescopeClient = {
    entries,
    entry: async () => {
      throw new Error('not used');
    },
    pulse: async () => {
      throw new Error('not used');
    },
    queues: async () => {
      throw new Error('not used');
    },
    timeseries: async () => {
      throw new Error('not used');
    },
    stats: async () => {
      throw new Error('not used');
    },
    meta: async () => ({
      enabled: true,
      droppedCount: 0,
      watchers: [],
      traceLink: null,
      retention: null,
      sampling: {},
    }),
    liveQueues: async () => {
      throw new Error('not used');
    },
    queueCounts: async () => {
      throw new Error('not used');
    },
    queueJobs: async () => {
      throw new Error('not used');
    },
    queueJob: async () => {
      throw new Error('not used');
    },
    queueJobAction: async () => ({ ok: true }),
    queueAction: async () => ({ ok: true }),
  };
  return { client, entries };
}

function renderAt(initialPath: string, client: TelescopeClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <TelescopeProvider client={client}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/traces/:traceId" element={<TracePage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </TelescopeProvider>,
  );
}

describe('TracePage', () => {
  it('requests entries filtered by traceId and renders all rows of mixed types', async () => {
    const { client, entries } = mockClient([
      entry({ id: 'e1', type: 'request', content: { method: 'GET', uri: '/users' } }),
      entry({ id: 'e2', type: 'query', content: { sql: 'select 1' } }),
      entry({ id: 'e3', type: 'cache', content: { message: 'hit user:1' } }),
    ]);
    renderAt('/traces/trace-1', client);

    await waitFor(() => {
      expect(entries).toHaveBeenCalledWith({ traceId: 'trace-1' });
    });

    expect(await screen.findByText('GET /users')).toBeTruthy();
    expect(screen.getByText('select 1')).toBeTruthy();
    expect(screen.getByText('hit user:1')).toBeTruthy();
    expect(screen.getByText('request')).toBeTruthy();
    expect(screen.getByText('query')).toBeTruthy();
    expect(screen.getByText('cache')).toBeTruthy();
    // header shows the traceId and the count
    expect(screen.getByText('trace-1')).toBeTruthy();
    expect(screen.getByText('3 entries')).toBeTruthy();
  });

  it('shows an empty state when no entries match the trace', async () => {
    const { client } = mockClient([]);
    renderAt('/traces/trace-empty', client);

    expect(await screen.findByText('No entries in this trace')).toBeTruthy();
  });
});
