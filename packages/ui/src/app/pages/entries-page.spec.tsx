import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { EntriesQuery, Entry, Page, TagCount, TelescopeClient } from '../../client/index.js';
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
    traceId: null,
    spanId: null,
    createdAt: '2026-06-03T12:00:00Z',
    ...over,
  };
}

const TAGS: TagCount[] = [
  { tag: 'slow', count: 42 },
  { tag: 'slow-query', count: 19 },
];

function mockClient(rows: Entry[]) {
  const entries = vi.fn<(query?: EntriesQuery) => Promise<Page<Entry>>>(async () => ({
    data: rows,
    nextCursor: null,
  }));
  const client: TelescopeClient = {
    entries,
    tags: async (prefix) =>
      prefix
        ? TAGS.filter((entry) => entry.tag.toLowerCase().includes(prefix.toLowerCase()))
        : TAGS,
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

  it('resolves the schedule route to the tagged-job query', async () => {
    const { client, entries } = mockClient([]);
    renderAt('/entries/schedule', client);

    await waitFor(() => {
      expect(entries).toHaveBeenCalledWith({ type: 'job', tag: 'schedule' });
    });
  });

  it('applies a tag picked from the autocomplete and shows a clearable chip', async () => {
    const { client, entries } = mockClient([]);
    renderAt('/entries', client);

    await waitFor(() => {
      expect(entries).toHaveBeenCalledWith({});
    });

    // typing surfaces suggestions but does not yet filter
    fireEvent.change(screen.getByLabelText('Filter by tag'), { target: { value: 'slow' } });
    const option = await screen.findByText('slow-query');

    // picking a suggestion applies it as the tag filter
    fireEvent.mouseDown(option);
    await waitFor(() => {
      expect(entries).toHaveBeenCalledWith({ tag: 'slow-query' });
    });

    // active-tag chip is shown and clears the filter when clicked
    const chip = await screen.findByText('tag:slow-query');
    expect(chip).toBeTruthy();
    fireEvent.click(chip);
    await waitFor(() => {
      expect(entries).toHaveBeenLastCalledWith({});
    });
  });

  it('passes a submitted free-text search through and shows a clearable chip', async () => {
    const { client, entries } = mockClient([]);
    renderAt('/entries', client);

    await waitFor(() => {
      expect(entries).toHaveBeenCalledWith({});
    });

    const input = screen.getByLabelText('Search content');
    fireEvent.change(input, { target: { value: 'orders' } });
    // typing alone must not refetch — only submit (Enter) does
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(entries).toHaveBeenCalledWith({ search: 'orders' });
    });

    const chip = await screen.findByText('search:"orders"');
    expect(chip).toBeTruthy();

    fireEvent.click(chip);
    await waitFor(() => {
      expect(entries).toHaveBeenLastCalledWith({});
    });
  });

  it('filters by familyHash from the query string and shows a clearable chip', async () => {
    const { client, entries } = mockClient([]);
    renderAt('/entries/query?familyHash=abc123', client);

    await waitFor(() => {
      expect(entries).toHaveBeenCalledWith({ type: 'query', familyHash: 'abc123' });
    });

    // active filter chip (clearable) shows the truncated hash
    const chip = await screen.findByText('abc123');
    expect(chip).toBeTruthy();

    fireEvent.click(chip);
    await waitFor(() => {
      expect(entries).toHaveBeenCalledWith({ type: 'query' });
    });
  });

  it('shows a type-aware empty state when nothing matches', async () => {
    const { client } = mockClient([]);
    renderAt('/entries/cache', client);

    expect(await screen.findByText('No Cache entries')).toBeTruthy();
  });
});
