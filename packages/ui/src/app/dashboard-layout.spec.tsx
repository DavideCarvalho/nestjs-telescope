import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HashRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { TelescopeClient } from '../client/index.js';
import { ENTRY_TYPES, TelescopeProvider } from '../react/index.js';
import { mockTelescopeClient } from '../testing/mock-telescope-client.js';
import { DashboardLayout, activeNavId, visibleTopNav } from './dashboard-layout.js';
import { ThemeProvider } from './theme-context.js';

const TOP_NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/traces', label: 'Traces', end: true },
  { to: '/pulse', label: 'Pulse', end: false },
];

function mockClient(watchers: string[] = []): TelescopeClient {
  return mockTelescopeClient({
    entries: async () => ({ data: [], nextCursor: null }),
    meta: async () => ({
      enabled: true,
      droppedCount: 0,
      watchers,
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
  });
}

function renderLayout(watchers?: string[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider>
      <TelescopeProvider client={mockClient(watchers)}>
        <QueryClientProvider client={queryClient}>
          <HashRouter>
            <DashboardLayout>
              <div>child</div>
            </DashboardLayout>
          </HashRouter>
        </QueryClientProvider>
      </TelescopeProvider>
    </ThemeProvider>,
  );
}

describe('DashboardLayout', () => {
  it('renders the nav sections and the page children', () => {
    renderLayout();
    expect(screen.getByText('child')).toBeTruthy();
    for (const label of ['Overview', 'Pulse', 'Entries', 'Traces', 'Queues', 'Schedules']) {
      expect(screen.getByRole('link', { name: label })).toBeTruthy();
    }
    for (const section of ['Monitor', 'Explore', 'Operations', 'Watchers', 'Data']) {
      expect(screen.getByText(section)).toBeTruthy();
    }
    // Exceptions sits under MONITOR, as the exception entries.
    expect(screen.getByRole('link', { name: 'Exceptions' }).getAttribute('href')).toBe(
      '#/entries/exception',
    );
  });

  /** Unfold the Watchers section and return it. */
  function openWatchers(): HTMLElement {
    fireEvent.click(screen.getByRole('button', { name: 'Watchers' }));
    const group = screen
      .getByRole('button', { name: 'Watchers' })
      .closest('[data-slot="sidebar-group"]');
    if (!(group instanceof HTMLElement)) throw new Error('no watchers group');
    return group;
  }

  it('renders every Watchers nav item before meta resolves (no flash-of-hidden-nav)', () => {
    // Asserting synchronously, before the async meta query settles: watchers is
    // still undefined, so the fallback shows the full list.
    renderLayout();
    const watchers = openWatchers();
    for (const type of ENTRY_TYPES) {
      const link = within(watchers).getByRole('link', { name: type.label });
      expect(link.getAttribute('href')).toBe(`#/entries/${type.id}`);
    }
  });

  it('hides Watchers nav items whose watcher meta positively reports as absent', async () => {
    // Only request, exception, and query are registered → redis/model/etc. drop
    // out of the nav once meta resolves.
    renderLayout(['request', 'exception', 'query']);
    const watchers = openWatchers();
    await waitFor(() => {
      expect(within(watchers).queryByRole('link', { name: 'Redis' })).toBeNull();
    });
    expect(within(watchers).getByRole('link', { name: 'Requests' })).toBeTruthy();
    expect(within(watchers).getByRole('link', { name: 'Queries' })).toBeTruthy();
    expect(within(watchers).getByRole('link', { name: 'Exceptions' })).toBeTruthy();
    expect(within(watchers).queryByRole('link', { name: 'Models' })).toBeNull();
    expect(within(watchers).queryByRole('link', { name: 'Mail' })).toBeNull();
  });

  it('maps each route to its sidebar item', () => {
    expect(activeNavId('/')).toBe('overview');
    expect(activeNavId('/entries/exception')).toBe('exceptions');
    expect(activeNavId('/entries')).toBe('entries');
    expect(activeNavId('/entries/view/abc')).toBe('entries');
    expect(activeNavId('/entries/query')).toBe('watcher:query');
    expect(activeNavId('/ext/billing')).toBe('dashboard:billing');
    expect(activeNavId('/queues/metrics')).toBe('queues');
    expect(activeNavId('/traces/t1')).toBe('traces');
  });

  it('hides the Traces nav item only when tracesEnabled is positively false', () => {
    // No traceContext on the host → Traces page is permanently empty → drop it.
    const hidden = visibleTopNav(TOP_NAV, false);
    expect(hidden.map((item) => item.to)).toEqual(['/', '/pulse']);
  });

  it('shows the Traces nav item when tracesEnabled is true', () => {
    const shown = visibleTopNav(TOP_NAV, true);
    expect(shown.map((item) => item.to)).toEqual(['/', '/traces', '/pulse']);
  });

  it('shows the Traces nav item when tracesEnabled is undefined (loading / older server)', () => {
    // No flash-of-hidden-nav and backward-compatible with servers predating the field.
    const shown = visibleTopNav(TOP_NAV, undefined);
    expect(shown.map((item) => item.to)).toEqual(['/', '/traces', '/pulse']);
  });

  it('hides the Profiles nav unless profiling is positively enabled', () => {
    const nav = [...TOP_NAV, { to: '/profiles', label: 'Profiles', end: false }];
    // Off / undefined → hidden (feature is off by default, page has no fallback).
    expect(visibleTopNav(nav, true, false).map((i) => i.to)).not.toContain('/profiles');
    expect(visibleTopNav(nav, true, undefined).map((i) => i.to)).not.toContain('/profiles');
    // Positively enabled → shown.
    expect(visibleTopNav(nav, true, true).map((i) => i.to)).toContain('/profiles');
  });

  it('defaults the live-tail toggle to Live and flips to Paused on click', () => {
    renderLayout();
    const toggle = screen.getByRole('button', { name: /live/i });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(toggle);

    const paused = screen.getByRole('button', { name: /paused/i });
    expect(paused.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(paused);
    expect(screen.getByRole('button', { name: /live/i }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });
});
