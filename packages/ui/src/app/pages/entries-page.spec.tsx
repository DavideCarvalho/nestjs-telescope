import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NuqsHashAdapter } from '../../aviary-kit/url-state/nuqs-hash-adapter';
import type { EntriesQuery, Entry, Page, TagCount, TelescopeClient } from '../../client/index.js';
import { TelescopeProvider } from '../../react/index.js';
import { LAST_PAGE_META, mockTelescopeClient } from '../../testing/mock-telescope-client.js';
import { settleUrlWrites } from '../settle-url.js';
import { EntriesPage } from './entries-page.js';

afterEach(settleUrlWrites);

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

function mockClient(rows: Entry[], extra: Partial<Page<Entry>> = {}) {
  const entries = vi.fn<(query?: EntriesQuery) => Promise<Page<Entry>>>(async () => ({
    data: rows,
    meta: LAST_PAGE_META,
    ...extra,
  }));
  const client: TelescopeClient = mockTelescopeClient({
    entries,
    tags: async (prefix) => ({
      data: prefix
        ? TAGS.filter((entry) => entry.tag.toLowerCase().includes(prefix.toLowerCase()))
        : TAGS,
      meta: LAST_PAGE_META,
    }),
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
  return { client, entries };
}

function renderAt(initialPath: string, client: TelescopeClient) {
  // The route path goes to the router; the filters are read from the real hash, as in the console.
  window.history.replaceState(null, '', `/#${initialPath}`);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <TelescopeProvider client={client}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          <NuqsHashAdapter>
            <Routes>
              <Route path="/entries" element={<EntriesPage />} />
              <Route path="/entries/:type" element={<EntriesPage />} />
            </Routes>
          </NuqsHashAdapter>
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
    // row summary derived from content, the page title and the active-type chip label
    expect(await screen.findByText('hit user:1')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Cache' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Cache/ })).toBeTruthy();
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

  it('seeds the tag filter from the ?tag= query string (user drill-down pivot)', async () => {
    const { client, entries } = mockClient([]);
    renderAt('/entries?tag=user%3A42', client);

    await waitFor(() => {
      expect(entries).toHaveBeenCalledWith({ tag: 'user:42' });
    });

    // a seeded user:<id> tag is RECOGNIZED and rendered in the dedicated User
    // control as a "User: <id>" chip — not the generic tag chip.
    const chip = await screen.findByText('User: 42');
    expect(chip).toBeTruthy();
    expect(screen.queryByText('tag:user:42')).toBeNull();
  });

  it('keeps the filters in the URL, so a reload opens the same filtered view', async () => {
    const first = mockClient([]);
    const view = renderAt('/entries/query', first.client);
    const input = screen.getByLabelText('Search content');
    fireEvent.change(input, { target: { value: 'orders' } });
    // typing alone does not touch the URL; the submitted search does
    expect(window.location.hash).toBe('#/entries/query');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(window.location.hash).toBe('#/entries/query?q=orders'));

    // "reload": a fresh page at the same URL
    view.unmount();
    const second = mockClient([]);
    renderAt('/entries/query?q=orders', second.client);
    await waitFor(() => {
      expect(second.entries).toHaveBeenCalledWith({ type: 'query', search: 'orders' });
    });
    expect((screen.getByLabelText('Search content') as HTMLInputElement).value).toBe('orders');
  });

  it('a submitted search rewrites the history entry; a picked tag adds one, so Back undoes it', async () => {
    const { client, entries } = mockClient([]);
    renderAt('/entries', client);
    const start = window.history.length;

    const input = screen.getByLabelText('Search content');
    fireEvent.change(input, { target: { value: 'orders' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(window.location.hash).toBe('#/entries?q=orders'));
    expect(window.history.length).toBe(start);

    fireEvent.change(screen.getByLabelText('Filter by tag'), { target: { value: 'slow' } });
    fireEvent.mouseDown(await screen.findByText('slow-query'));
    await waitFor(() => expect(window.location.hash).toBe('#/entries?q=orders&tag=slow-query'));
    expect(window.history.length).toBe(start + 1);

    act(() => window.history.back());
    await waitFor(() => {
      expect(entries).toHaveBeenLastCalledWith({ search: 'orders' });
    });
    expect(screen.queryByText('tag:slow-query')).toBeNull();
  });

  it('clearing the family filter keeps the other filters', async () => {
    const { client, entries } = mockClient([]);
    renderAt('/entries/query?familyHash=abc123&tag=slow-query', client);
    await waitFor(() => {
      expect(entries).toHaveBeenCalledWith({
        type: 'query',
        tag: 'slow-query',
        familyHash: 'abc123',
      });
    });
    fireEvent.click(await screen.findByText('abc123'));
    await waitFor(() => expect(window.location.hash).toBe('#/entries/query?tag=slow-query'));
    await waitFor(() => {
      expect(entries).toHaveBeenLastCalledWith({ type: 'query', tag: 'slow-query' });
    });
  });

  it('applies a user filter via the dedicated User control and shows a User chip', async () => {
    const { client, entries } = mockClient([]);
    renderAt('/entries', client);

    await waitFor(() => {
      expect(entries).toHaveBeenCalledWith({});
    });

    // the User combobox queries the `user:` namespace; selecting an id applies
    // the underlying `user:<id>` tag but the chip reads as a user, not a tag.
    fireEvent.change(screen.getByLabelText('Filter by user'), { target: { value: '7' } });
    fireEvent.keyDown(screen.getByLabelText('Filter by user'), { key: 'Enter' });

    await waitFor(() => {
      expect(entries).toHaveBeenCalledWith({ tag: 'user:7' });
    });
    expect(await screen.findByText('User: 7')).toBeTruthy();
  });

  it('clears the other combobox draft when a selection lands in one control', async () => {
    const { client } = mockClient([]);
    renderAt('/entries', client);

    await waitFor(() => {
      expect(screen.getByLabelText('Filter by tag')).toBeTruthy();
    });

    // leave a stale draft in the generic tag input, then apply a User selection
    const tagInput = screen.getByLabelText('Filter by tag');
    fireEvent.change(tagInput, { target: { value: 'slow' } });
    fireEvent.change(screen.getByLabelText('Filter by user'), { target: { value: '7' } });
    fireEvent.keyDown(screen.getByLabelText('Filter by user'), { key: 'Enter' });

    // the generic control remounts, so its leftover 'slow' draft is gone
    await waitFor(() => {
      expect(screen.getByLabelText('Filter by tag')).toHaveProperty('value', '');
    });
  });

  it('shows a type-aware empty state when nothing matches', async () => {
    const { client } = mockClient([]);
    renderAt('/entries/cache', client);

    expect(await screen.findByText('No Cache entries')).toBeTruthy();
  });

  it('shows a non-blocking notice, alongside the rows, when the page is partial', async () => {
    const { client } = mockClient([entry({ type: 'cache', content: { message: 'hit user:1' } })], {
      partial: true,
    });
    renderAt('/entries', client);
    expect((await screen.findByRole('status')).textContent).toMatch(
      /Older entries are unavailable/,
    );
    expect(await screen.findByText('hit user:1')).toBeTruthy();
  });

  it('shows no notice for a complete page', async () => {
    const { client } = mockClient([entry({ type: 'cache', content: { message: 'hit user:1' } })]);
    renderAt('/entries', client);
    await screen.findByText('hit user:1');
    expect(screen.queryByText(/Older entries are unavailable/)).toBeNull();
  });
});
