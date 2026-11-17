import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ConsoleAppsInfo } from '../client/index.js';
import { TelescopeProvider } from '../react/index.js';
import { LAST_PAGE_META, mockTelescopeClient } from '../testing/mock-telescope-client.js';
import { AppPicker } from './app-picker.js';
import { FederatedAppNotice } from './federated-app-notice.js';

const apps = [
  { id: 'billing', label: 'Billing', federated: true as const },
  { id: 'shop', label: 'Shop' },
];

function renderAt(pathname: string, info: ConsoleAppsInfo) {
  const client = mockTelescopeClient({
    entries: async () => ({ data: [], meta: LAST_PAGE_META }),
    apps: async () => info,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <TelescopeProvider client={client}>
      <QueryClientProvider client={queryClient}>
        <div>page</div>
        <FederatedAppNotice pathname={pathname} />
        <AppPicker />
      </QueryClientProvider>
    </TelescopeProvider>,
  );
}

const federatedInView: ConsoleAppsInfo = {
  enabled: true,
  tag: 'app',
  all: true,
  selected: 'billing',
  apps,
  federation: { selected: true },
};

describe('Federated app notice', () => {
  it('says a process page does not show a federated app', async () => {
    renderAt('/schedules', federatedInView);
    expect(await screen.findByRole('note')).toHaveProperty(
      'textContent',
      expect.stringContaining('Billing is a federated app'),
    );
  });

  it('stays out of pages read from the store', async () => {
    renderAt('/entries', federatedInView);
    expect(await screen.findByText(/App:/)).toBeTruthy();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('stays out when the app in view is not federated', async () => {
    renderAt('/schedules', {
      ...federatedInView,
      selected: 'shop',
      federation: { selected: false },
    });
    expect(await screen.findByText(/App:/)).toBeTruthy();
    expect(screen.queryByRole('note')).toBeNull();
  });
});
