import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HashRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { TelescopeClient } from '../client/index.js';
import { ENTRY_TYPES, TelescopeProvider } from '../react/index.js';
import { DashboardLayout } from './dashboard-layout.js';
import { ThemeProvider } from './theme-context.js';

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
