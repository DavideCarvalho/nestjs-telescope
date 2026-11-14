// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConsoles, resetConsoleCache } from '../console-data';
import { parseShellConfig, readShellConfig } from '../shell-config';
import { ThemeProvider } from '../theme';
import {
  ConsoleSearch,
  type SearchCommand,
  filterCommands,
  useSearchShortcut,
} from './console-search';
import { ConsoleSwitcher } from './console-switcher';
import { UserFooter } from './user-footer';

const config = { endpoint: '/durable/api/consoles', others: 3 };
const brand = <span>durable brand</span>;
const current = {
  title: 'Workflows',
  package: '@dudousxd/nestjs-durable',
  icon: 'workflow' as const,
};

function respond(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetConsoleCache();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const consoles = {
  version: 1,
  current: 'durable',
  consoles: [
    {
      id: 'telescope',
      title: 'Telescope',
      package: '@dudousxd/nestjs-telescope',
      icon: 'telescope',
      href: '/telescope',
    },
    { id: 'media', title: 'Media', icon: 'media', href: '/media' },
    { id: 'odd', title: 'Odd', icon: 'nope', href: '/odd' },
    { id: 'evil', title: 'Evil', icon: 'generic', href: '//evil.example' },
    { id: 'evil2', title: 'Evil 2', icon: 'generic', href: 'javascript:alert(1)' },
  ],
};

async function openMenu() {
  const button = await screen.findByRole('button', { name: /switch console/ });
  await act(async () => {
    fireEvent.click(button);
  });
  return { button, menu: await screen.findByRole('menu') };
}

describe('ConsoleSwitcher', () => {
  it('renders the plain brand and makes no request without config', () => {
    render(<ConsoleSwitcher brand={brand} current={current} config={undefined} />);
    expect(screen.getByText('durable brand')).toBeTruthy();
    expect(document.querySelector('[data-aviary-switcher]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stays a plain brand when the list is empty or the request fails', async () => {
    fetchMock.mockReturnValue(respond({ version: 1, current: 'durable', consoles: [] }));
    render(<ConsoleSwitcher brand={brand} current={current} config={config} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(document.querySelector('[data-aviary-switcher]')).toBeNull();
    cleanup();
    resetConsoleCache();
    fetchMock.mockReturnValue(respond({ error: 'forbidden' }, 403));
    render(<ConsoleSwitcher brand={brand} current={current} config={config} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(document.querySelector('[data-aviary-switcher]')).toBeNull();
  });

  it('lists the current console first (not a link), then the others; drops unsafe hrefs', async () => {
    fetchMock.mockReturnValue(respond(consoles));
    render(<ConsoleSwitcher brand={brand} current={current} config={config} />);
    expect(await screen.findByText('durable brand')).toBeTruthy();
    const { button } = await openMenu();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const items = screen.getAllByRole('menuitem');
    expect(items[0]?.tagName).not.toBe('A');
    expect(items[0]?.getAttribute('aria-current')).toBe('page');
    expect(items[0]?.textContent).toContain('Workflows');
    const links = items.filter((el) => el.tagName === 'A');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/telescope', '/media', '/odd']);
    expect(links[0]?.textContent).toContain('@dudousxd/nestjs-telescope');
    // An unknown icon renders the generic one.
    expect(links[2]?.querySelector('svg')?.getAttribute('data-icon')).toBe('generic');
  });

  it('retries a failed consoles request on the next call, and caches a successful one', async () => {
    fetchMock.mockReturnValueOnce(Promise.reject(new TypeError('network down')));
    expect(await loadConsoles(config)).toEqual([]);
    fetchMock.mockReturnValue(respond(consoles));
    expect((await loadConsoles(config)).map((c) => c.id)).toEqual(['telescope', 'media', 'odd']);
    await loadConsoles(config);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('closes on Escape', async () => {
    fetchMock.mockReturnValue(respond(consoles));
    render(<ConsoleSwitcher brand={brand} current={current} config={config} />);
    const { menu } = await openMenu();
    await act(async () => {
      fireEvent.keyDown(menu, { key: 'Escape' });
    });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('offers "Search all consoles" when given onSearch', async () => {
    fetchMock.mockReturnValue(respond(consoles));
    const onSearch = vi.fn();
    render(<ConsoleSwitcher brand={brand} current={current} config={config} onSearch={onSearch} />);
    await openMenu();
    await act(async () => {
      fireEvent.click(screen.getByText('Search all consoles'));
    });
    expect(onSearch).toHaveBeenCalled();
  });
});

function SearchHarness() {
  const [open, setOpen] = useState(false);
  useSearchShortcut(true, setOpen);
  return (
    <ConsoleSearch
      config={{ endpoint: '/durable/api/consoles/search' }}
      open={open}
      onOpenChange={setOpen}
    />
  );
}

describe('ConsoleSearch', () => {
  it('Cmd-K opens it, searches every console and groups the hits (unsafe hrefs dropped)', async () => {
    fetchMock.mockImplementation(() =>
      respond({
        version: 1,
        q: 'ord',
        results: [
          {
            id: 'media',
            title: 'Media',
            icon: 'media',
            hits: [
              { title: 'pi_123', subtitle: 'paid', href: '/media#/p/pi_123' },
              { title: 'bad', href: 'https://evil.example' },
            ],
          },
        ],
      }),
    );
    render(<SearchHarness />);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'k', metaKey: true });
    });
    const input = await screen.findByRole('combobox', { name: 'Search all consoles' });
    fireEvent.change(input, { target: { value: 'ord' } });
    await waitFor(() => expect(screen.getByText('pi_123')).toBeTruthy(), { timeout: 2000 });
    expect(fetchMock).toHaveBeenCalledWith(
      '/durable/api/consoles/search?q=ord',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
    expect(screen.queryByText('bad')).toBeNull();
    expect(screen.getByText('Media')).toBeTruthy();
  });

  it('also reads `{ groups }` answers', async () => {
    fetchMock.mockImplementation(() =>
      respond({
        groups: [
          {
            id: 'agent',
            title: 'Agents',
            icon: 'agent',
            hits: [{ title: 'ann@x.test', href: '/agent#/threads/ann' }],
          },
        ],
      }),
    );
    render(<SearchHarness />);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    });
    fireEvent.change(await screen.findByRole('combobox', { name: 'Search all consoles' }), {
      target: { value: 'ann' },
    });
    await waitFor(() => expect(screen.getByText('ann@x.test')).toBeTruthy(), { timeout: 2000 });
  });
});

describe('ConsoleSearch hit clicks', () => {
  const hitAnswer = {
    results: [
      {
        id: 'media',
        title: 'Media',
        icon: 'media',
        hits: [{ title: 'pi_9', href: '/media#/p/pi_9' }],
      },
    ],
  };

  async function openWithHit() {
    fetchMock.mockImplementation(() => respond(hitAnswer));
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    render(<SearchHarness />);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'k', metaKey: true });
    });
    fireEvent.change(await screen.findByRole('combobox', { name: 'Search all consoles' }), {
      target: { value: 'pi' },
    });
    await waitFor(() => expect(screen.getByText('pi_9')).toBeTruthy(), { timeout: 2000 });
    const link = screen.getByText('pi_9').closest('a') as HTMLAnchorElement;
    return { assign, link };
  }

  it('navigates exactly once on a plain left click', async () => {
    const { assign, link } = await openWithHit();
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    await act(async () => {
      link.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('/media#/p/pi_9');
  });

  it('leaves modified clicks to the browser (new tab, window, download)', async () => {
    const { assign, link } = await openWithHit();
    for (const mod of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const) {
      const click = new MouseEvent('click', { bubbles: true, cancelable: true, [mod]: true });
      link.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(false);
    }
    expect(assign).not.toHaveBeenCalled();
  });
});

function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return {
    promise,
    resolve: (body: unknown, status = 200) =>
      resolve(new Response(JSON.stringify(body), { status })),
  };
}

const mediaHit = (title: string) => ({
  results: [
    {
      id: 'media',
      title: 'Media',
      icon: 'media',
      hits: [{ title, href: `/media#/p/${title}` }],
    },
  ],
});

async function openAndType(value: string) {
  render(<SearchHarness />);
  await act(async () => {
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
  });
  const input = await screen.findByRole('combobox', { name: 'Search all consoles' });
  fireEvent.change(input, { target: { value } });
  return input;
}

const spinner = () => document.querySelector('[data-aviary-search-spinner]');
const skeleton = () => document.querySelector('[data-aviary-search-skeleton]');
const listbox = () => document.querySelector('[cmdk-list]');

describe('ConsoleSearch loading', () => {
  it('shows a spinner and skeleton rows while the first answer loads, never "Nothing found"', async () => {
    const first = deferred();
    fetchMock.mockReturnValue(first.promise);
    await openAndType('zzz');
    expect(spinner()).toBeTruthy();
    expect(skeleton()).toBeTruthy();
    expect(listbox()?.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText('Nothing found.')).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(screen.queryByText('Nothing found.')).toBeNull();
    await act(async () => {
      first.resolve({ results: [] });
    });
    await waitFor(() => expect(screen.getByText('Nothing found.')).toBeTruthy());
    expect(spinner()).toBeNull();
    expect(skeleton()).toBeNull();
    expect(listbox()?.getAttribute('aria-busy')).toBe('false');
  });

  it('keeps the previous hits visible but dimmed during a re-search', async () => {
    fetchMock.mockReturnValueOnce(respond(mediaHit('pi_1')));
    const input = await openAndType('pi');
    await waitFor(() => expect(screen.getByText('pi_1')).toBeTruthy(), { timeout: 2000 });
    expect(document.querySelector('[data-stale]')).toBeNull();

    const second = deferred();
    fetchMock.mockReturnValueOnce(second.promise);
    fireEvent.change(input, { target: { value: 'pi_2' } });
    expect(screen.getByText('pi_1')).toBeTruthy();
    expect(document.querySelector('[data-stale]')).toBeTruthy();
    expect(spinner()).toBeTruthy();
    expect(skeleton()).toBeNull();
    expect(screen.queryByText('Nothing found.')).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 2000 });
    await act(async () => {
      second.resolve(mediaHit('pi_2'));
    });
    await waitFor(() => expect(screen.getByText('pi_2')).toBeTruthy());
    expect(screen.queryByText('pi_1')).toBeNull();
    expect(document.querySelector('[data-stale]')).toBeNull();
    expect(spinner()).toBeNull();
  });

  it('shows a quiet error line (not "Nothing found") when the search fails, and retries', async () => {
    fetchMock.mockReturnValueOnce(respond({ error: 'boom' }, 500));
    await openAndType('ord');
    await waitFor(() => expect(document.querySelector('[data-aviary-search-error]')).toBeTruthy(), {
      timeout: 2000,
    });
    expect(screen.getByText(/didn't answer/)).toBeTruthy();
    expect(screen.queryByText('Nothing found.')).toBeNull();
    expect(spinner()).toBeNull();
    fetchMock.mockReturnValueOnce(respond(mediaHit('pi_9')));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('pi_9')).toBeTruthy(), { timeout: 2000 });
    expect(document.querySelector('[data-aviary-search-error]')).toBeNull();
  });
});

describe('ConsoleSearch per console', () => {
  const searchCfg = { endpoint: '/durable/api/consoles/search', self: 'durable' };
  const switcherCfg = { endpoint: '/durable/api/consoles', others: 2 };
  const group = (id: string, title: string) => ({
    results: [{ id, title, icon: 'generic', hits: [{ title: `${id}-hit`, href: `/${id}#/x` }] }],
  });

  function PerConsole() {
    return <ConsoleSearch config={searchCfg} switcher={switcherCfg} open onOpenChange={() => {}} />;
  }

  it('asks each console on its own and streams the groups in, counting the rest', async () => {
    const telescope = deferred();
    const media = deferred();
    fetchMock.mockImplementation((url: string) => {
      if (url === '/durable/api/consoles') {
        return respond({
          version: 1,
          current: 'durable',
          consoles: [
            { id: 'telescope', title: 'Telescope', icon: 'telescope', href: '/telescope' },
            { id: 'media', title: 'Media', icon: 'media', href: '/media' },
          ],
        });
      }
      if (url.endsWith('console=durable')) return respond(group('durable', 'Workflows'));
      if (url.endsWith('console=telescope')) return telescope.promise;
      return media.promise;
    });
    render(<PerConsole />);
    fireEvent.change(await screen.findByRole('combobox', { name: 'Search all consoles' }), {
      target: { value: 'ord' },
    });
    await waitFor(() => expect(screen.getByText('durable-hit')).toBeTruthy(), { timeout: 2000 });
    expect(fetchMock).toHaveBeenCalledWith(
      '/durable/api/consoles/search?q=ord&console=telescope',
      expect.anything(),
    );
    expect(screen.getByText('Searching 2 consoles…')).toBeTruthy();
    expect(spinner()).toBeTruthy();
    await act(async () => {
      // A server that ignores `console` answers every group: only telescope's is kept.
      telescope.resolve({
        results: [...group('telescope', 'Telescope').results, ...group('media', 'Media').results],
      });
    });
    await waitFor(() => expect(screen.getByText('telescope-hit')).toBeTruthy());
    expect(screen.queryByText('media-hit')).toBeNull();
    expect(screen.getByText('Searching 1 console…')).toBeTruthy();
    await act(async () => {
      media.resolve({}, 500);
    });
    await waitFor(() =>
      expect(document.querySelector('[data-aviary-search-partial]')).toBeTruthy(),
    );
    expect(screen.getByText(/1 console didn't answer/)).toBeTruthy();
    expect(spinner()).toBeNull();
    expect(screen.queryByText('Nothing found.')).toBeNull();
  });

  it('shows "Searching N consoles…" skeleton rows until the first hit, then "Nothing found."', async () => {
    const slow = deferred();
    fetchMock.mockImplementation((url: string) => {
      if (url === '/durable/api/consoles') {
        return respond({
          version: 1,
          current: 'durable',
          consoles: [{ id: 'media', title: 'Media', icon: 'media', href: '/media' }],
        });
      }
      if (url.endsWith('console=durable')) return respond({ results: [] });
      return slow.promise;
    });
    render(<PerConsole />);
    fireEvent.change(await screen.findByRole('combobox', { name: 'Search all consoles' }), {
      target: { value: 'zzz' },
    });
    await waitFor(() => expect(screen.getByText('Searching 1 console…')).toBeTruthy(), {
      timeout: 2000,
    });
    expect(skeleton()).toBeTruthy();
    expect(screen.queryByText('Nothing found.')).toBeNull();
    await act(async () => {
      slow.resolve({ results: [] });
    });
    await waitFor(() => expect(screen.getByText('Nothing found.')).toBeTruthy());
    expect(skeleton()).toBeNull();
  });
});

describe('ConsoleSearch commands', () => {
  const commands: SearchCommand[] = [
    { id: 'runs', label: 'Runs', group: 'Pages', onSelect: vi.fn() },
    { id: 'workers', label: 'Workers', group: 'Pages', keywords: ['nodes'], onSelect: vi.fn() },
  ];

  it('filterCommands matches label and keywords, case-insensitively', () => {
    expect(filterCommands(commands, '').map((c) => c.id)).toEqual(['runs', 'workers']);
    expect(filterCommands(commands, 'NOD').map((c) => c.id)).toEqual(['workers']);
    expect(filterCommands(commands, 'x')).toEqual([]);
  });

  it('lists local commands without a search endpoint and runs the chosen one', async () => {
    const onOpenChange = vi.fn();
    render(<ConsoleSearch commands={commands} open onOpenChange={onOpenChange} />);
    const input = await screen.findByRole('combobox', { name: 'Search' });
    expect(screen.getByText('Runs')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'nodes' } });
    expect(screen.queryByText('Runs')).toBeNull();
    fireEvent.click(screen.getByText('Workers'));
    expect(commands[1]?.onSelect).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    fireEvent.change(input, { target: { value: 'qqq' } });
    expect(screen.getByText('Nothing found.')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('UserFooter', () => {
  it('shows the viewer, and signs out with a POST form carrying the CSRF token', () => {
    render(
      <ThemeProvider storageKey="test-theme">
        <UserFooter
          viewer={{ label: 'Ann Lee', email: 'ann@x.test', role: 'admin' }}
          signOut={{ action: '/account/logout', csrfToken: 'tok' }}
        />
      </ThemeProvider>,
    );
    expect(screen.getByText('Ann Lee')).toBeTruthy();
    expect(screen.getByText('AL')).toBeTruthy();
    expect(screen.getByText('admin')).toBeTruthy();
    const submit = screen.getByRole('button', { name: 'Sign out' });
    expect(submit.getAttribute('type')).toBe('submit');
    const form = submit.closest('form');
    expect(form?.getAttribute('action')).toBe('/account/logout');
    expect(form?.getAttribute('method')).toBe('post');
    expect(form?.querySelector<HTMLInputElement>('input[name="_csrf"]')?.value).toBe('tok');
  });

  it('renders a sign-out link, and no user row without a viewer', () => {
    render(
      <ThemeProvider storageKey="test-theme">
        <UserFooter signOut={{ href: '/logout' }} />
      </ThemeProvider>,
    );
    expect(document.querySelector('[data-aviary-viewer]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign out' }).getAttribute('href')).toBe('/logout');
  });

  it('toggles the theme on <html> and remembers it', () => {
    // Node 26 ships its own `localStorage`, which is undefined without --localstorage-file and
    // shadows the DOM one; the kit tolerates that, so give this test a storage of its own.
    const saved = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => void saved.set(key, value),
      removeItem: (key: string) => void saved.delete(key),
    });
    render(
      <ThemeProvider storageKey="test-theme">
        <UserFooter />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light mode' }));
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(saved.get('test-theme')).toBe('light');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark mode' }));
    expect(document.documentElement.classList.contains('light')).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('shell config (the data block)', () => {
  function block(json: string) {
    document.body.innerHTML = `<script type="application/json" id="cfg">${json}</script>`;
  }

  it('reads switcher, search, viewer and sign-out', () => {
    block(
      JSON.stringify({
        base: '/durable',
        switcher: { endpoint: '/durable/api/consoles', others: 2 },
        search: { endpoint: '/durable/api/consoles/search' },
        viewer: { label: 'Ann', email: 'ann@x.test', role: 'admin' },
        signOut: { action: '/account/logout', csrfToken: 't' },
      }),
    );
    expect(readShellConfig('cfg')).toEqual({
      switcher: { endpoint: '/durable/api/consoles', others: 2 },
      search: { endpoint: '/durable/api/consoles/search' },
      viewer: { label: 'Ann', email: 'ann@x.test', role: 'admin' },
      signOut: { action: '/account/logout', csrfToken: 't' },
    });
  });

  it('keeps a valid `self` id on the search config (per-console mode)', () => {
    expect(parseShellConfig({ search: { endpoint: '/d/api/s', self: 'durable' } }).search).toEqual({
      endpoint: '/d/api/s',
      self: 'durable',
    });
    expect(parseShellConfig({ search: { endpoint: '/d/api/s', self: 'Bad Id' } }).search).toEqual({
      endpoint: '/d/api/s',
    });
  });

  it('trims viewer text like the server does', () => {
    expect(parseShellConfig({ viewer: { label: '  Ann  ', role: ' admin ' } }).viewer).toEqual({
      label: 'Ann',
      role: 'admin',
    });
  });

  it('derives the search endpoint from the switcher for older servers', () => {
    expect(
      parseShellConfig({ switcher: { endpoint: '/p/api/consoles', others: 1 } }).search,
    ).toEqual({
      endpoint: '/p/api/consoles/search',
    });
  });

  it('ignores absent, empty or unsafe fields', () => {
    block('{"base":"/durable"}');
    expect(readShellConfig('cfg')).toEqual({});
    expect(parseShellConfig({ switcher: { endpoint: '/x', others: 0 } }).switcher).toBeUndefined();
    expect(
      parseShellConfig({ switcher: { endpoint: '//evil.example/x', others: 2 } }).switcher,
    ).toBeUndefined();
    expect(
      parseShellConfig({ signOut: { action: 'https://evil.example/out' } }).signOut,
    ).toBeUndefined();
    expect(parseShellConfig({ signOut: { href: '/\\evil' } }).signOut).toBeUndefined();
    expect(parseShellConfig({ viewer: { label: '' } }).viewer).toBeUndefined();
    block('not json');
    expect(readShellConfig('cfg')).toEqual({});
  });
});
