import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TelescopeClient } from '../../../client/telescope-client.js';
import type { TelescopeMeta } from '../../../client/types.js';
import { mockTelescopeClient } from '../../../testing/mock-telescope-client.js';
import { TelescopeProvider } from '../../telescope-context.js';
import { PanelActionsProvider, actionShownFor, fillFromRow } from './panel-actions.js';
import { PanelTable } from './panel-table.js';
import type { TableColumnSpec } from './table-columns.js';

const columns: TableColumnSpec[] = [
  { key: 'name', label: 'Circuit' },
  {
    key: 'status',
    label: 'Status',
    action: {
      name: 'reset-circuit',
      input: { name: '{name}' },
      showWhen: { status: ['open', 'half-open'] },
    },
  },
];

const rows = [
  { name: 'stripe', status: 'open' },
  { name: 'mailer', status: 'closed' },
];

function meta(mutations: boolean): TelescopeMeta {
  return {
    dashboards: [],
    actions: [
      {
        ext: 'resilience',
        name: 'reset-circuit',
        label: 'Reset',
        confirm: 'Reset circuit {name}?',
        destructive: true,
      },
    ],
    mutations,
  } as unknown as TelescopeMeta;
}

function renderTable(client: TelescopeClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TelescopeProvider client={client}>
        <PanelActionsProvider ext="resilience">
          <PanelTable columns={columns} rows={rows} />
        </PanelActionsProvider>
      </TelescopeProvider>
    </QueryClientProvider>,
  );
}

describe('row actions', () => {
  it('shows the button on matching rows, confirms, then runs the action with the row input', async () => {
    const extAction = vi.fn(async () => ({ ok: true as const, result: null }));
    renderTable(mockTelescopeClient({ meta: async () => meta(true), extAction }));
    const buttons = await screen.findAllByRole('button', { name: 'Reset' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(await screen.findByText('Reset circuit stripe?')).toBeTruthy();
    expect(extAction).not.toHaveBeenCalled();
    const dialogButtons = screen.getAllByRole('button', { name: 'Reset' });
    fireEvent.click(dialogButtons[dialogButtons.length - 1]!);
    await waitFor(() =>
      expect(extAction).toHaveBeenCalledWith('resilience', 'reset-circuit', { name: 'stripe' }),
    );
    expect(await screen.findByText('Reset: done.')).toBeTruthy();
  });

  it('reports a failed run', async () => {
    const extAction = vi.fn(async () => {
      throw new Error('Mutations are disabled');
    });
    renderTable(mockTelescopeClient({ meta: async () => meta(true), extAction }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reset' }));
    const dialogButtons = await screen.findAllByRole('button', { name: 'Reset' });
    fireEvent.click(dialogButtons[dialogButtons.length - 1]!);
    expect(await screen.findByText('Reset failed: Mutations are disabled')).toBeTruthy();
  });

  it('shows no button while mutations are off', async () => {
    const metaFn = vi.fn(async () => meta(false));
    renderTable(mockTelescopeClient({ meta: metaFn, extAction: vi.fn() }));
    await waitFor(() => expect(metaFn).toHaveBeenCalled());
    expect(await screen.findByText('stripe')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull();
  });
});

describe('action helpers', () => {
  it('fills templates and matches showWhen', () => {
    expect(fillFromRow('Reset {name} ({missing})?', { name: 'a' })).toBe('Reset a ()?');
    expect(actionShownFor({ name: 'x' }, {})).toBe(true);
    expect(actionShownFor({ name: 'x', showWhen: { s: ['open'] } }, { s: 'closed' })).toBe(false);
  });
});
