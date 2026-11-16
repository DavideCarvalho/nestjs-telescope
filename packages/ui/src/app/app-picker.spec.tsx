import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { HashRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { ConsoleAppsInfo, Entry } from '../client/index.js';
import { EntriesTable, TelescopeProvider } from '../react/index.js';
import { LAST_PAGE_META, mockTelescopeClient } from '../testing/mock-telescope-client.js';
import { AppPicker } from './app-picker.js';

function renderPicker(info: ConsoleAppsInfo) {
  const client = mockTelescopeClient({
    entries: async () => ({ data: [], meta: LAST_PAGE_META }),
    apps: async (search) => ({
      ...info,
      apps: info.apps.filter((a) => !search || a.label.toLowerCase().includes(search)),
    }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <TelescopeProvider client={client}>
      <QueryClientProvider client={queryClient}>
        <HashRouter>
          <div>header</div>
          <AppPicker />
        </HashRouter>
      </QueryClientProvider>
    </TelescopeProvider>,
  );
}

const two = [
  { id: 'billing', label: 'Billing' },
  { id: 'shop', label: 'Shop' },
];

describe('App control', () => {
  it('is hidden on a standalone app', async () => {
    renderPicker({ enabled: false, tag: 'app', all: true, selected: null, apps: [] });
    expect(await screen.findByText('header')).toBeTruthy();
    expect(screen.queryByText(/App:/)).toBeNull();
  });

  it('one granted app: a fixed chip', async () => {
    renderPicker({ enabled: true, tag: 'app', all: false, selected: 'shop', apps: [two[1]!] });
    expect(await screen.findByText('Shop')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /App/ })).toBeNull();
  });

  it('every app: a picker with All apps first, searchable, keyboard and Escape', async () => {
    renderPicker({ enabled: true, tag: 'app', all: true, selected: null, apps: two });
    const button = await screen.findByRole('button', { name: /App: All apps/ });
    fireEvent.click(button);
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['All apps', 'Billing', 'Shop']);
    fireEvent.keyDown(screen.getByLabelText('Search apps'), { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('All apps');
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('Billing');
    fireEvent.change(screen.getByLabelText('Search apps'), { target: { value: 'zzz' } });
    expect(await screen.findByText('No app found.', {}, { timeout: 2_000 })).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText('Search apps'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('labels the selected app', async () => {
    renderPicker({ enabled: true, tag: 'app', all: true, selected: 'shop', apps: two });
    expect(await screen.findByRole('button', { name: /App: Shop/ })).toBeTruthy();
  });
});

function entry(id: string, tags: string[]): Entry {
  return {
    id,
    batchId: 'b',
    type: 'request',
    familyHash: null,
    content: { method: 'GET', uri: `/${id}`, statusCode: 200 },
    tags,
    sequence: 0,
    durationMs: 1,
    origin: 'http',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt: new Date().toISOString(),
  } as unknown as Entry;
}

describe('App column', () => {
  it('shows when entries of several apps are in view', () => {
    render(<EntriesTable entries={[entry('a', ['app:shop']), entry('b', ['app:billing'])]} />);
    expect(screen.getByRole('columnheader', { name: 'App' })).toBeTruthy();
    expect(screen.getByText('billing')).toBeTruthy();
  });

  it('is absent for one app or none', () => {
    render(<EntriesTable entries={[entry('a', ['app:shop']), entry('b', [])]} />);
    expect(screen.queryByRole('columnheader', { name: 'App' })).toBeNull();
  });
});
