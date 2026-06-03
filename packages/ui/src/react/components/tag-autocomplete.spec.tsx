import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TagCount, TelescopeClient } from '../../client/index.js';
import { TelescopeProvider } from '../index.js';
import { TagAutocomplete } from './tag-autocomplete.js';

const ALL_TAGS: TagCount[] = [
  { tag: 'slow', count: 42 },
  { tag: 'schedule', count: 7 },
  { tag: 'slow-query', count: 19 },
];

function mockClient(tags: TagCount[] = ALL_TAGS) {
  const tagsFn = vi.fn<(prefix?: string) => Promise<TagCount[]>>(async (prefix) =>
    prefix ? tags.filter((entry) => entry.tag.toLowerCase().includes(prefix.toLowerCase())) : tags,
  );
  const client: TelescopeClient = {
    tags: tagsFn,
    entries: async () => {
      throw new Error('not used');
    },
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
    meta: async () => ({ enabled: true, droppedCount: 0, watchers: [], traceLink: null }),
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

    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(2);
    // sorted by count desc → slow (42) before slow-query (19)
    expect(options[0]?.textContent).toContain('slow');
    expect(options[0]?.textContent).toContain('42');
    expect(options[1]?.textContent).toContain('slow-query');
    expect(options[1]?.textContent).toContain('19');
    // a non-matching tag is absent
    expect(screen.queryByText('schedule')).toBeNull();
  });

  it('does not open a dropdown for empty input', async () => {
    renderAutocomplete();
    const input = screen.getByLabelText('Filter by tag');
    fireEvent.focus(input);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('false');
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
