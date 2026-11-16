// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConsoleCache } from '../console-data';
import type { AviaryShellConfig } from '../shell-config';
import { AppShell, type NavSection } from './app-shell';
import { type SearchCommand, filterCommands, matchScore } from './console-search';
import { consoleCommands, pageCommands } from './navigation';

function respond(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

let fetchMock: ReturnType<typeof vi.fn>;
const assign = vi.fn<(url: string | URL) => void>();

beforeEach(() => {
  resetConsoleCache();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  assign.mockClear();
  vi.spyOn(window.location, 'assign').mockImplementation(assign);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const consoles = {
  version: 1,
  current: 'agent',
  consoles: [
    {
      id: 'durable',
      title: 'Workflows',
      package: '@dudousxd/nestjs-durable',
      icon: 'workflow',
      href: '/durable',
    },
    { id: 'payments', title: 'Payments', icon: 'payments', href: '/payments' },
  ],
};

function agentNav(onSelect: (id: string) => void): NavSection[] {
  const item = (id: string, label: string, extra: object = {}) => ({
    id,
    label,
    icon: <span />,
    href: `#/${id}`,
    onSelect: () => onSelect(id),
    ...extra,
  });
  return [
    {
      section: 'Overview',
      items: [item('dashboard', 'Dashboard'), item('agents', 'Agents')],
    },
    {
      section: 'Conversations',
      items: [item('threads', 'Threads', { keywords: ['conversations', 'chats'] })],
    },
    {
      section: 'Tools',
      collapsible: true,
      items: [item('tool:search', 'Web search')],
    },
  ];
}

function Shell({
  nav,
  shell,
  commands,
}: {
  nav: NavSection[];
  shell: AviaryShellConfig;
  commands?: SearchCommand[];
}) {
  return (
    <AppShell
      brand={{
        name: 'agent',
        mark: <span />,
        current: { title: 'Agents', package: '@dudousxd/nestjs-agent', icon: 'agent' },
      }}
      nav={nav}
      activeId="dashboard"
      shell={shell}
      title="Dashboard"
      commands={commands}
    >
      <p>page</p>
    </AppShell>
  );
}

async function openPalette(name = 'Search') {
  await act(async () => {
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
  });
  return screen.findByRole('combobox', { name });
}

const options = () => screen.queryAllByRole('option').map((o) => o.textContent ?? '');

describe('matchScore', () => {
  it('is case- and accent-insensitive and ranks label matches above keyword matches', () => {
    expect(matchScore('THREADS', 'Threads')).toBe(0);
    expect(matchScore('thréads', 'Threads')).toBe(0);
    expect(matchScore('Agê', 'Agents')).toBe(1);
    expect(matchScore('runs', 'Recent runs')).toBe(2);
    expect(matchScore('dura', 'Go to Workflows', ['durable'])).toBe(4);
    expect(matchScore('xyz', 'Threads', ['chats'])).toBeUndefined();
  });

  it('forgives plural and gender endings ("agente" → Agents) and matches every typed word', () => {
    expect(matchScore('agente', 'Agents')).toBeDefined();
    expect(matchScore('agentes', 'Agents')).toBeDefined();
    expect(matchScore('go durable', 'Go to Workflows', ['durable'])).toBeDefined();
    expect(matchScore('agentic-workflows-xyz', 'Agents')).toBeUndefined();
  });

  it('filterCommands puts the best match first and keeps ties in order', () => {
    const commands: SearchCommand[] = [
      { id: 'a', label: 'Schedules', group: 'g', keywords: ['runs'], onSelect: () => {} },
      { id: 'b', label: 'Runs', group: 'g', onSelect: () => {} },
      { id: 'c', label: 'Recent runs', group: 'g', onSelect: () => {} },
    ];
    expect(filterCommands(commands, 'runs').map((c) => c.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('navigation commands', () => {
  it('pageCommands lists every nav page under the console name, with its section as hint', () => {
    const pages = pageCommands(
      agentNav(() => {}),
      'Agents',
    );
    expect(pages.map((p) => [p.label, p.group, p.hint])).toEqual([
      ['Dashboard', 'Agents', 'Overview'],
      ['Agents', 'Agents', 'Overview'],
      ['Threads', 'Agents', 'Conversations'],
      ['Web search', 'Agents', 'Tools'],
    ]);
    expect(pages.find((p) => p.label === 'Web search')?.hideUntilTyped).toBe(true);
  });

  it('pageCommands follows the href when an item has no onSelect', () => {
    const [page] = pageCommands(
      [{ section: 'S', items: [{ id: 'x', label: 'X', icon: null, href: '/x' }] }],
      'C',
    );
    page?.onSelect();
    expect(assign).toHaveBeenCalledWith('/x');
  });

  it('consoleCommands matches a console by title, id, package and usual names', () => {
    const list = consoleCommands([
      {
        id: 'durable',
        title: 'Workflows',
        package: '@dudousxd/nestjs-durable',
        icon: 'workflow',
        href: '/durable',
      },
    ]);
    for (const q of ['durable', 'Workflows', 'nestjs-durable', 'DURÁBLE']) {
      expect(filterCommands(list, q).map((c) => c.label)).toEqual(['Go to Workflows']);
    }
  });
});

describe('⌘K navigation in AppShell', () => {
  it('opens without a search endpoint or commands and lists the pages and consoles', async () => {
    fetchMock.mockImplementation(() => respond(consoles));
    render(
      <Shell
        nav={agentNav(() => {})}
        shell={{ switcher: { endpoint: '/agent/consoles', others: 2 } }}
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await openPalette();
    await waitFor(() => expect(options()).toContain('Go to Workflows@dudousxd/nestjs-durable'));
    expect(options()).toEqual([
      'DashboardOverview',
      'AgentsOverview',
      'ThreadsConversations',
      'Go to Workflows@dudousxd/nestjs-durable',
      'Go to Payments',
    ]);
    // Only the switcher list is fetched: no search request without an endpoint.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('"threads" finds the Threads page and Enter navigates like a click on the nav item', async () => {
    const onSelect = vi.fn();
    render(<Shell nav={agentNav(onSelect)} shell={{}} />);
    const input = await openPalette();
    fireEvent.change(input, { target: { value: 'THREADS' } });
    expect(options()).toEqual(['ThreadsConversations']);
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(onSelect).toHaveBeenCalledWith('threads');
    await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull());
  });

  it('"durable" finds the Durable console and selecting it opens it', async () => {
    fetchMock.mockImplementation(() => respond(consoles));
    render(
      <Shell
        nav={agentNav(() => {})}
        shell={{ switcher: { endpoint: '/agent/consoles', others: 2 } }}
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const input = await openPalette();
    fireEvent.change(input, { target: { value: 'durable' } });
    await waitFor(() => expect(options()).toEqual(['Go to Workflows@dudousxd/nestjs-durable']));
    fireEvent.click(screen.getByText('Go to Workflows'));
    expect(assign).toHaveBeenCalledWith('/durable');
  });

  it('finds pages accent-insensitively ("agênte" → Agents) and shows collapsed pages once typed', async () => {
    render(<Shell nav={agentNav(() => {})} shell={{}} />);
    const input = await openPalette();
    expect(options()).not.toContain('Web searchTools');
    fireEvent.change(input, { target: { value: 'agênte' } });
    expect(options()).toEqual(['AgentsOverview']);
    fireEvent.change(input, { target: { value: 'web' } });
    expect(options()).toEqual(['Web searchTools']);
  });

  it('lists pages, then consoles, then commands, then the data hits', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.startsWith('/agent/consoles/search')
        ? respond({
            results: [
              {
                id: 'durable',
                title: 'Workflows',
                icon: 'workflow',
                hits: [{ title: 'trace-run-1', href: '/durable#/runs/trace-run-1' }],
              },
            ],
          })
        : respond({
            ...consoles,
            consoles: [
              ...consoles.consoles,
              { id: 'telescope', title: 'Telescope', icon: 'telescope', href: '/telescope' },
            ],
          }),
    );
    const commands: SearchCommand[] = [
      { id: 'f', label: 'Filter: traces with errors', group: 'Filters', onSelect: vi.fn() },
    ];
    const nav: NavSection[] = [
      { section: 'Debug', items: [{ id: 'traces', label: 'Traces', icon: null, href: '#/t' }] },
    ];
    render(
      <Shell
        nav={nav}
        commands={commands}
        shell={{
          switcher: { endpoint: '/agent/consoles', others: 3 },
          search: { endpoint: '/agent/consoles/search' },
        }}
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const input = await openPalette('Search all consoles');
    fireEvent.change(input, { target: { value: 'trac' } });
    await waitFor(() => expect(screen.getByText('trace-run-1')).toBeTruthy(), { timeout: 2000 });
    expect(options()).toEqual([
      'TracesDebug',
      'Go to Telescope',
      'Filter: traces with errors',
      'trace-run-1',
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/agent/consoles/search?q=trac',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });
});
