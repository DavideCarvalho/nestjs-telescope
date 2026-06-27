import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { TelescopeClient } from '../../client/index.js';
import { TelescopeProvider } from '../../react/index.js';
import { ExportsPage } from './exports-page.js';

function mockClient(): TelescopeClient {
  return {
    entries: async () => ({ data: [], nextCursor: null }),
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <TelescopeProvider client={mockClient()}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ExportsPage />
        </MemoryRouter>
      </QueryClientProvider>
    </TelescopeProvider>,
  );
}

describe('ExportsPage', () => {
  it('renders the export form with type, window, format and an export button', () => {
    renderPage();
    expect(screen.getByText('Export workbench')).toBeTruthy();
    expect(screen.getByText('Type')).toBeTruthy();
    expect(screen.getByText('Window')).toBeTruthy();
    expect(screen.getByText('Format')).toBeTruthy();
    expect(screen.getByText('Limit')).toBeTruthy();
    // format options
    expect(screen.getByRole('option', { name: 'JSON' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'CSV' })).toBeTruthy();
    // the export action
    expect(screen.getByRole('button', { name: 'Export' })).toBeTruthy();
  });

  it('shows an empty state for the per-session recent exports list', () => {
    renderPage();
    expect(screen.getByText(/No exports yet/)).toBeTruthy();
  });
});
