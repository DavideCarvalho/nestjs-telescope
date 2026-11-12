// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConsoleSwitcher,
  type SwitcherConfig,
  readSwitcherConfig,
  resetSwitcherCache,
} from './console-switcher.js';

const CONFIG: SwitcherConfig = { endpoint: '/telescope/api/consoles', others: 3 };

function serve(consoles: unknown[]) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ version: 1, current: 'telescope', consoles }), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const brand = <span>Telescope</span>;

async function mount(config: SwitcherConfig | undefined) {
  const view = render(
    <ConsoleSwitcher
      brand={brand}
      current={{ title: 'Telescope', icon: 'telescope' }}
      config={config}
    />,
  );
  // Let the one fetch settle.
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

beforeEach(() => {
  resetSwitcherCache();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('readSwitcherConfig', () => {
  function block(json: string) {
    const el = document.createElement('script');
    el.type = 'application/json';
    el.id = 'telescope-dashboard-config';
    el.textContent = json;
    document.body.append(el);
  }

  it('reads the switcher field of the config block', () => {
    block(JSON.stringify({ base: '/a', switcher: CONFIG }));
    expect(readSwitcherConfig('telescope-dashboard-config')).toEqual(CONFIG);
  });

  it('is absent without the field, with none others, or with an unsafe endpoint', () => {
    expect(readSwitcherConfig('telescope-dashboard-config')).toBeUndefined();
    block(JSON.stringify({ base: '/a' }));
    expect(readSwitcherConfig('telescope-dashboard-config')).toBeUndefined();
    document.body.innerHTML = '';
    block(JSON.stringify({ switcher: { endpoint: '//evil.test/x', others: 1 } }));
    expect(readSwitcherConfig('telescope-dashboard-config')).toBeUndefined();
    document.body.innerHTML = '';
    block(JSON.stringify({ switcher: { endpoint: '/x', others: 0 } }));
    expect(readSwitcherConfig('telescope-dashboard-config')).toBeUndefined();
  });
});

describe('ConsoleSwitcher', () => {
  it('renders the plain brand and makes no request without a config', async () => {
    const fetchMock = serve([]);
    await mount(undefined);
    expect(screen.getByText('Telescope')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders the plain brand when the list is empty', async () => {
    const fetchMock = serve([]);
    const { container } = await mount(CONFIG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelector('[data-aviary-switcher]')).toBeNull();
  });

  it('opens a menu: the current console first (not a link), then the others as links', async () => {
    serve([
      { id: 'durable', title: 'Workflows', icon: 'workflow', href: '/durable' },
      { id: 'odd', title: 'Odd', icon: 'rocket', href: '/odd' },
      { id: 'evil', title: 'Evil', icon: 'media', href: '//evil.test' },
      { id: 'js', title: 'Script', icon: 'media', href: 'javascript:alert(1)' },
    ]);
    const { container } = await mount(CONFIG);
    const button = screen.getByRole('button', { name: 'Telescope: switch console' });
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const items = screen.getAllByRole('menuitem');
    expect(items.map((el) => el.textContent)).toEqual(['Telescope', 'Workflows', 'Odd']);
    expect(items[0]?.tagName).toBe('DIV');
    expect(items[0]?.getAttribute('aria-current')).toBe('page');
    expect(items[1]?.getAttribute('href')).toBe('/durable');
    // An unknown icon falls back to the generic glyph.
    expect(items[2]?.querySelector('svg')?.getAttribute('data-icon')).toBe('generic');
    expect(container.querySelector('a[href="//evil.test"]')).toBeNull();
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it('keyboard: ArrowDown opens on the first item, arrows/Home/End move, Esc closes and restores focus', async () => {
    serve([
      { id: 'durable', title: 'Workflows', icon: 'workflow', href: '/durable' },
      { id: 'media', title: 'Media', icon: 'media', href: '/media' },
    ]);
    await mount(CONFIG);
    const button = screen.getByRole('button', { name: 'Telescope: switch console' });
    button.focus();
    fireEvent.keyDown(button, { key: 'ArrowDown' });
    const items = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('Enter opens too, and a click outside closes', async () => {
    serve([{ id: 'durable', title: 'Workflows', icon: 'workflow', href: '/durable' }]);
    await mount(CONFIG);
    const button = screen.getByRole('button', { name: 'Telescope: switch console' });
    fireEvent.keyDown(button, { key: 'Enter' });
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('fetches the list once per page', async () => {
    const fetchMock = serve([{ id: 'durable', title: 'Workflows', icon: 'workflow', href: '/d' }]);
    await mount(CONFIG);
    cleanup();
    await mount(CONFIG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a failed request reads as no switcher', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 403 })),
    );
    await mount(CONFIG);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
