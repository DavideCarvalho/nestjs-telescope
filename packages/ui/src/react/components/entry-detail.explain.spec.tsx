import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  EntryWithBatch,
  ExplainResult,
  TelescopeClient,
  TelescopeMeta,
} from '../../client/index.js';
import { TelescopeProvider } from '../telescope-context.js';
import { EntryDetail } from './entry-detail.js';

function mockClient(meta: TelescopeMeta, explain: (id: string) => Promise<ExplainResult>) {
  return {
    entries: async () => ({ data: [], nextCursor: null }),
    entry: async () => {
      throw new Error('not used');
    },
    meta: async () => meta,
    explain,
  } as unknown as TelescopeClient;
}

function queryEntry(): EntryWithBatch {
  return {
    id: 'q1',
    batchId: 'b',
    type: 'query',
    familyHash: null,
    content: { sql: 'select * from users where id = ?', bindings: [42], slow: true },
    tags: [],
    sequence: 0,
    durationMs: 12,
    origin: 'http',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt: '2026-06-03T12:00:00Z',
    batch: [],
  };
}

function meta(explainEnabled: boolean): TelescopeMeta {
  return {
    enabled: true,
    droppedCount: 0,
    watchers: [],
    traceLink: null,
    retention: null,
    pruneEnabled: false,
    explainEnabled,
    sampling: {},
  };
}

function renderQueryDetail(
  explainEnabled: boolean,
  explain: (id: string) => Promise<ExplainResult>,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <TelescopeProvider client={mockClient(meta(explainEnabled), explain)}>
      <QueryClientProvider client={queryClient}>
        <EntryDetail entry={queryEntry()} />
      </QueryClientProvider>
    </TelescopeProvider>,
  );
}

describe('EntryDetail query explain', () => {
  it('renders the SQL and bindings', async () => {
    renderQueryDetail(false, async () => ({ ok: true, plan: {} }));
    expect(await screen.findByText('select * from users where id = ?')).toBeTruthy();
    expect(screen.getByText('Bindings')).toBeTruthy();
  });

  it('hides the Explain button when explain is not enabled', async () => {
    renderQueryDetail(false, async () => ({ ok: true, plan: {} }));
    await screen.findByText('select * from users where id = ?');
    expect(screen.queryByRole('button', { name: 'Explain' })).toBeNull();
  });

  it('renders the plan JSON after clicking Explain', async () => {
    const explain = vi.fn(async () => ({
      ok: true as const,
      plan: { query_block: { cost: '1.0' } },
    }));
    renderQueryDetail(true, explain);
    const button = await screen.findByRole('button', { name: 'Explain' });
    fireEvent.click(button);
    await waitFor(() => {
      expect(screen.getByText('Query plan')).toBeTruthy();
    });
    expect(explain).toHaveBeenCalledWith('q1');
    expect(screen.getByText(/"query_block"/)).toBeTruthy();
  });

  it('renders the error message when the explain hook fails', async () => {
    renderQueryDetail(true, async () => ({ ok: false, message: 'connection refused' }));
    const button = await screen.findByRole('button', { name: 'Explain' });
    fireEvent.click(button);
    await waitFor(() => {
      expect(screen.getByText('connection refused')).toBeTruthy();
    });
  });
});
