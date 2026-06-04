import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { HashRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { TelescopeClient } from '../client/index.js';
import { ENTRY_TYPES, TelescopeProvider } from '../react/index.js';
import { DashboardLayout } from './dashboard-layout.js';

function mockClient(): TelescopeClient {
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
      watchers: [],
      traceLink: null,
      retention: null,
      sampling: {},
    }),
  };
}

function renderLayout() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <TelescopeProvider client={mockClient()}>
      <QueryClientProvider client={queryClient}>
        <HashRouter>
          <DashboardLayout>
            <div>child</div>
          </DashboardLayout>
        </HashRouter>
      </QueryClientProvider>
    </TelescopeProvider>,
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

  it('renders a Watchers nav item per entry type with a hash href to its filtered list', () => {
    renderLayout();
    expect(screen.getByText('Watchers')).toBeTruthy();
    for (const type of ENTRY_TYPES) {
      const link = screen.getByRole('link', { name: type.label });
      expect(link.getAttribute('href')).toBe(`#/entries/${type.id}`);
    }
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
