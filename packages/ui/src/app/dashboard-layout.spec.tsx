import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HashRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { TelescopeClient } from '../client/index.js';
import { ENTRY_TYPES, TelescopeProvider } from '../react/index.js';
import { DashboardLayout, visibleTopNav } from './dashboard-layout.js';
import { ThemeProvider } from './theme-context.js';

const TOP_NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/traces', label: 'Traces', end: true },
  { to: '/pulse', label: 'Pulse', end: false },
];

function mockClient(watchers: string[] = []): TelescopeClient {
  return {
    entries: async () => ({ data: [], nextCursor: null }),
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
      watchers,
      traceLink: null,
      retention: null,
      sampling: {},
    }),
  };
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
  it('renders the top-level nav and the page children', () => {
    renderLayout();
    expect(screen.getByText('child')).toBeTruthy();
    for (const label of ['Overview', 'Entries', 'Traces', 'Pulse', 'Queues']) {
      expect(screen.getByRole('link', { name: label })).toBeTruthy();
    }
  });

  it('renders every Watchers nav item before meta resolves (no flash-of-hidden-nav)', () => {
    // Asserting synchronously, before the async meta query settles: watchers is
    // still undefined, so the fallback shows the full list.
    renderLayout();
    expect(screen.getByText('Watchers')).toBeTruthy();
    for (const type of ENTRY_TYPES) {
      const link = screen.getByRole('link', { name: type.label });
      expect(link.getAttribute('href')).toBe(`#/entries/${type.id}`);
    }
  });

  it('hides Watchers nav items whose watcher meta positively reports as absent', async () => {
    // Only request, exception, and query are registered → redis/model/etc. drop
    // out of the nav once meta resolves.
    renderLayout(['request', 'exception', 'query']);
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Redis' })).toBeNull();
    });
    expect(screen.getByRole('link', { name: 'Requests' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Queries' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Exceptions' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Models' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Mail' })).toBeNull();
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
