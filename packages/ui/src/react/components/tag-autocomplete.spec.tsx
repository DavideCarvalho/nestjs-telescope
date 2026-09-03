import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TagCount, TelescopeClient } from '../../client/index.js';
import { mockTelescopeClient } from '../../testing/mock-telescope-client.js';
import { TelescopeProvider } from '../index.js';
import { TagAutocomplete } from './tag-autocomplete.js';

const ALL_TAGS: TagCount[] = [
  { tag: 'slow', count: 42 },
  { tag: 'schedule', count: 7 },
  { tag: 'slow-query', count: 19 },
];

/** A stand-in for the server's `GET /tags`: it scopes by `prefix`, narrows by `search`, orders by
 *  count and cuts a page — the same contract the storage providers implement, so a component tested
 *  against it is tested against what it will actually be given. */
function mockClient(tags: TagCount[] = ALL_TAGS) {
  const tagsFn = vi.fn<
    (
      prefix?: string,
      opts?: { search?: string; limit?: number; offset?: number },
    ) => Promise<TagCount[]>
  >(async (prefix, opts) => {
    const search = opts?.search?.trim().toLowerCase();
    const matching = tags
      .filter((entry) => !prefix || entry.tag.startsWith(prefix))
      .filter((entry) => !search || entry.tag.toLowerCase().includes(search))
      .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag));
    const offset = opts?.offset ?? 0;
    return opts?.limit === undefined ? matching : matching.slice(offset, offset + opts.limit);
  });
  const client: TelescopeClient = mockTelescopeClient({
    tags: tagsFn,
    meta: async () => ({
      enabled: true,
      droppedCount: 0,
      watchers: [],
      traceLink: null,
      retention: null,
      pruneEnabled: false,
      explainEnabled: false,
      auth: { enabled: false, modes: [] },
      sampling: {},
    }),
    queueJobAction: async () => ({ ok: true }),
    queueAction: async () => ({ ok: true }),
  });
  return { client, tagsFn };
}

function renderAutocomplete(onSelect = vi.fn(), client?: TelescopeClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const resolved = client ?? mockClient().client;
  render(
    <TelescopeProvider client={resolved}>
      <QueryClientProvider client={queryClient}>
        <TagAutocomplete onSelect={onSelect} />
      </QueryClientProvider>
    </TelescopeProvider>,
  );
  return { onSelect };
}

describe('TagAutocomplete', () => {
  it('shows matching tag suggestions with their counts as the user types', async () => {
    renderAutocomplete();
    fireEvent.change(screen.getByLabelText('Filter by tag'), { target: { value: 'slow' } });

    // The list narrows once typing SETTLES: the search is debounced into one request, and until it
    // lands the previous answer stays on screen rather than blanking on every keystroke.
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));

    const options = screen.getAllByRole('option');
    // sorted by count desc → slow (42) before slow-query (19)
    expect(options[0]?.textContent).toContain('slow');
    expect(options[0]?.textContent).toContain('42');
    expect(options[1]?.textContent).toContain('slow-query');
    expect(options[1]?.textContent).toContain('19');
    // a non-matching tag is absent
    expect(screen.queryByText('schedule')).toBeNull();
  });

  it('offers what exists as soon as it is focused, before anything is typed', async () => {
    // It used to require typing first, which asks an operator to guess a first character in order to
    // discover what is there. The list is the answer to "what can I filter by" — showing it is the
    // whole reason a picker beats a text box.
    renderAutocomplete();

    fireEvent.focus(screen.getByLabelText('Filter by tag'));

    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('slow'),
      expect.stringContaining('slow-query'),
      expect.stringContaining('schedule'),
    ]);
  });

  it('asks the server to search and page, rather than slicing what it holds', async () => {
    // The list is bounded because tag cardinality grows with the data, so the values worth
    // searching for are routinely the ones the bound cut — a client-side filter cannot reach them.
    const { client, tagsFn } = mockClient();
    renderAutocomplete(vi.fn(), client);

    fireEvent.change(screen.getByLabelText('Filter by tag'), { target: { value: 'slow' } });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));

    expect(tagsFn).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ search: 'slow', limit: expect.any(Number), offset: 0 }),
    );
  });

  it('asks for the next page when the list is scrolled to its end', async () => {
    const many: TagCount[] = Array.from({ length: 60 }, (_, i) => ({
      tag: `tag-${i}`,
      count: 60 - i,
    }));
    const { client, tagsFn } = mockClient(many);
    renderAutocomplete(vi.fn(), client);

    fireEvent.focus(screen.getByLabelText('Filter by tag'));
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0));
    tagsFn.mockClear();
    fireEvent.scroll(screen.getByRole('listbox'));

    // The offset is what has already been loaded, not a page number — a short page cannot desync it.
    await waitFor(() =>
      expect(tagsFn).toHaveBeenCalledWith(undefined, expect.objectContaining({ offset: 50 })),
    );
  });

  it('applies a clicked suggestion as the selected tag and closes the list', async () => {
    const { onSelect } = renderAutocomplete();
    fireEvent.change(screen.getByLabelText('Filter by tag'), { target: { value: 'slow' } });

    const option = await screen.findByText('slow-query');
    fireEvent.mouseDown(option);

    expect(onSelect).toHaveBeenCalledWith('slow-query');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });

  it('selects the highlighted suggestion on ArrowDown + Enter', async () => {
    const { onSelect } = renderAutocomplete();
    const input = screen.getByLabelText('Filter by tag');
    fireEvent.change(input, { target: { value: 'slow' } });

    await screen.findAllByRole('option');
    // highlight starts at 0 (slow); ArrowDown moves to slow-query
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith('slow-query');
  });

  it('closes the dropdown on Escape', async () => {
    renderAutocomplete();
    const input = screen.getByLabelText('Filter by tag');
    fireEvent.change(input, { target: { value: 'slow' } });

    await screen.findByRole('listbox');
    fireEvent.keyDown(input, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });

  it('closes the dropdown when clicking away', async () => {
    renderAutocomplete();
    fireEvent.change(screen.getByLabelText('Filter by tag'), { target: { value: 'slow' } });

    await screen.findByRole('listbox');
    fireEvent.mouseDown(document.body);

    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });

  it('commits the raw typed text on Enter when no suggestion matches', async () => {
    const { client } = mockClient([]);
    const { onSelect } = renderAutocomplete(vi.fn(), client);
    const input = screen.getByLabelText('Filter by tag');
    fireEvent.change(input, { target: { value: 'nope' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith('nope');
  });
});
