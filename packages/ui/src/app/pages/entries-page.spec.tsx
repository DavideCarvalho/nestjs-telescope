import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { EntriesQuery, Entry, Page, TelescopeClient } from '../../client/index.js';
import { TelescopeProvider } from '../../react/index.js';
import { EntriesPage } from './entries-page.js';

function entry(over: Partial<Entry> & { type: string }): Entry {
  return {
    id: 'e1',
    batchId: 'b',
    familyHash: null,
    content: {},
    tags: [],
    sequence: 0,
    durationMs: 12,
    origin: 'http',
    instanceId: 'i',
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
    meta: async () => ({ enabled: true, droppedCount: 0, watchers: [] }),
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
            <Route path="/entries" element={<EntriesPage />} />
            <Route path="/entries/:type" element={<EntriesPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </TelescopeProvider>,
  );
}

describe('EntriesPage', () => {
  it('requests entries filtered to the :type route param and renders rows', async () => {
    const { client, entries } = mockClient([
      entry({ type: 'cache', content: { message: 'hit user:1' } }),
    ]);
    renderAt('/entries/cache', client);

    await waitFor(() => {
      expect(entries).toHaveBeenCalledWith({ type: 'cache' });
    });
    // row summary derived from content + the active-type chip label
    expect(await screen.findByText('hit user:1')).toBeTruthy();
    expect(screen.getByText('Cache')).toBeTruthy();
  });

  it('passes the tag filter input through to the entries query', async () => {
    const { client, entries } = mockClient([]);
    renderAt('/entries', client);

    await waitFor(() => {
      expect(entries).toHaveBeenCalledWith({});
    });

    fireEvent.change(screen.getByLabelText('Filter by tag'), { target: { value: 'slow' } });

    await waitFor(() => {
      expect(entries).toHaveBeenCalledWith({ tag: 'slow' });
    });
  });

  it('shows a type-aware empty state when nothing matches', async () => {
    const { client } = mockClient([]);
    renderAt('/entries/cache', client);

    expect(await screen.findByText('No Cache entries')).toBeTruthy();
  });
});
