import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NuqsHashAdapter } from '../../aviary-kit/url-state/nuqs-hash-adapter';
import type {
  ConsoleAppsInfo,
  TelescopeClient,
  TraceSummary,
  TracesResult,
  Waterfall,
} from '../../client/index.js';
import { WaterfallView } from '../../react/components/waterfall-view.js';
import { TelescopeProvider } from '../../react/index.js';
import { mockTelescopeClient } from '../../testing/mock-telescope-client.js';
import { settleUrlWrites } from '../settle-url.js';
import { TracesPage } from './traces-page.js';

afterEach(settleUrlWrites);

const crossApp: Waterfall = {
  traceStartMs: 0,
  totalDurationMs: 100,
  apps: ['shop', 'billing'],
  spans: [
    {
      id: 'shop-req',
      type: 'request',
      label: 'POST /orders',
      offsetMs: 0,
      durationMs: 100,
      depth: 0,
      sequence: 0,
      app: 'shop',
      children: [
        {
          id: 'billing-req',
          type: 'request',
          label: 'POST /charges',
          offsetMs: 20,
          durationMs: 40,
          depth: 1,
          sequence: 0,
          app: 'billing',
          children: [],
        },
      ],
    },
  ],
};

describe('cross-app waterfall', () => {
  it('shows an app column and the apps the trace crossed', () => {
    render(<WaterfallView waterfall={crossApp} appLabels={{ shop: 'Shop' }} />);
    expect(screen.getByTestId('waterfall-across').textContent).toBe('Across Shop → billing');
    expect(screen.getAllByTestId('waterfall-app').map((cell) => cell.textContent)).toEqual([
      'Shop',
      'billing',
    ]);
  });

  it('shows no app column for a trace in one app', () => {
    const single: Waterfall = { ...crossApp, apps: ['shop'] };
    render(<WaterfallView waterfall={single} />);
    expect(screen.queryByTestId('waterfall-app')).toBeNull();
    expect(screen.queryByTestId('waterfall-across')).toBeNull();
  });

  it('notes the spans hidden in other apps', () => {
    const limited: Waterfall = {
      ...crossApp,
      apps: ['shop'],
      hiddenSpans: 3,
      spans: [{ ...(crossApp.spans[0] as Waterfall['spans'][number]), children: [] }],
    };
    render(<WaterfallView waterfall={limited} />);
    expect(screen.getByTestId('waterfall-hidden').textContent).toBe('3 spans in other apps hidden');
  });
});

function summary(over: Partial<TraceSummary> & { traceId: string }): TraceSummary {
  return {
    entryCount: 2,
    types: ['request'],
    firstAt: '2026-06-03T12:00:00Z',
    lastAt: '2026-06-03T12:00:01Z',
    totalDurationMs: 42,
    rootLabel: 'POST /orders',
    ...over,
  };
}

function renderTraces(rows: TraceSummary[]) {
  const traces = vi.fn<(window?: string, size?: number) => Promise<TracesResult>>(async () => ({
    data: rows,
    scanned: rows.length,
    truncated: false,
  }));
  const apps = vi.fn<(search?: string) => Promise<ConsoleAppsInfo>>(async () => ({
    enabled: true,
    tag: 'app',
    all: true,
    selected: null,
    apps: [
      { id: 'shop', label: 'Shop' },
      { id: 'billing', label: 'Billing' },
    ],
  }));
  const client: TelescopeClient = mockTelescopeClient({ traces, apps });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <TelescopeProvider client={client}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/traces']}>
          <NuqsHashAdapter>
            <Routes>
              <Route path="/traces" element={<TracesPage />} />
            </Routes>
          </NuqsHashAdapter>
        </MemoryRouter>
      </QueryClientProvider>
    </TelescopeProvider>,
  );
}

describe('trace list', () => {
  it('has an Apps column when traces carry apps', async () => {
    renderTraces([summary({ traceId: 't1', apps: ['shop', 'billing'] })]);
    await waitFor(() =>
      expect(screen.getByTestId('trace-apps').textContent).toBe('Shop → Billing'),
    );
  });

  it('has none for an app recording for itself', async () => {
    renderTraces([summary({ traceId: 't1' })]);
    await waitFor(() => expect(screen.getByText('POST /orders')).toBeTruthy());
    expect(screen.queryByTestId('trace-apps')).toBeNull();
  });
});
