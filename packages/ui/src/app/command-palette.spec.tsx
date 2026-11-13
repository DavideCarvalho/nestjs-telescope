import { fireEvent, render, screen } from '@testing-library/react';
import { HashRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CommandPalette,
  PALETTE_ACTIONS,
  filterActions,
  searchActions,
  usePalette,
} from './command-palette.js';

function Harness(): JSX.Element {
  const { open, setOpen } = usePalette();
  return (
    <HashRouter>
      <button type="button" onClick={() => setOpen(true)}>
        trigger
      </button>
      <CommandPalette open={open} onClose={() => setOpen(false)} />
    </HashRouter>
  );
}

function renderHarness() {
  window.location.hash = '';
  return render(<Harness />);
}

describe('command palette actions', () => {
  it('includes every entry type and the static pages', () => {
    const labels = PALETTE_ACTIONS.map((action) => action.label);
    expect(labels).toContain('Overview');
    expect(labels).toContain('Pulse');
    expect(labels).toContain('Traces');
    expect(labels).toContain('Requests');
    expect(labels).toContain('Queries');
  });

  it('filters by case-insensitive substring', () => {
    const result = filterActions(PALETTE_ACTIONS, 'over');
    expect(result.map((action) => action.label)).toContain('Overview');
    expect(result.every((action) => action.label.toLowerCase().includes('over'))).toBe(true);
  });
});

describe('CommandPalette', () => {
  it('opens on Cmd+K', () => {
    renderHarness();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('opens on Ctrl+K', () => {
    renderHarness();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('opens from the trigger badge', () => {
    renderHarness();
    fireEvent.click(screen.getByText('trigger'));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('typing filters the action list', () => {
    renderHarness();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = screen.getByLabelText('Search actions');
    fireEvent.change(input, { target: { value: 'pulse' } });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]!.textContent).toBe('Pulse');
  });

  it('Enter on the highlighted action navigates to its hash route and closes', () => {
    renderHarness();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = screen.getByLabelText('Search actions');
    fireEvent.change(input, { target: { value: 'pulse' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(window.location.hash).toBe('#/pulse');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ArrowDown moves the highlight before Enter navigates', () => {
    renderHarness();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = screen.getByLabelText('Search actions');
    fireEvent.change(input, { target: { value: 'queue' } });
    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThan(1);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(window.location.hash).toBe('#/queues/metrics');
  });

  it('Escape closes the palette', () => {
    renderHarness();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = screen.getByLabelText('Search actions');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('CommandPalette global search', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('adds every console’s hits under the page actions, and opens one as a link', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            version: 1,
            q: 'run',
            partial: true,
            results: [
              {
                id: 'durable',
                title: 'Workflows',
                icon: 'workflow',
                hits: [{ title: 'run 42', subtitle: 'completed', href: '/durable#/run/42' }],
              },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    render(
      <HashRouter>
        <CommandPalette open onClose={() => undefined} searchEndpoint="/telescope/api/consoles" />
      </HashRouter>,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'run' } });
    const hit = await screen.findByText('run 42');
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(
      '/telescope/api/consoles/search?q=run',
    );
    expect(screen.getByText('Workflows · completed')).toBeTruthy();
    expect(screen.getByText(/did not answer in time/)).toBeTruthy();
    fireEvent.mouseDown(hit);
    expect(assign).toHaveBeenCalledWith('/durable#/run/42');
  });

  it('does not search without an endpoint', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <HashRouter>
        <CommandPalette open onClose={() => undefined} />
      </HashRouter>,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'runs' } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('searchActions', () => {
  it('turns groups into link rows labelled with the console', () => {
    expect(
      searchActions({
        partial: false,
        groups: [{ id: 'a', title: 'A', icon: 'generic', hits: [{ title: 'x', href: '/a#x' }] }],
      }),
    ).toEqual([{ id: 'search-a-0', label: 'x', to: '', href: '/a#x', detail: 'A' }]);
  });
});
