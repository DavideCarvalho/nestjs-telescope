import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EntryWithBatch, TelescopeClient, TelescopeMeta } from '../../client/index.js';
import { TelescopeProvider } from '../telescope-context.js';
import { EntryDetail } from './entry-detail.js';

function mockClient(meta: TelescopeMeta): TelescopeClient {
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
    meta: async () => meta,
    liveQueues: async () => ({
      queues: [],
      capabilities: { mutationsEnabled: false, actionsByDriver: {} },
    }),
    queueCounts: async () => ({
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
      paused: 0,
    }),
    queueJobs: async () => ({ jobs: [], nextCursor: null, total: 0 }),
    queueJob: async () => null,
    queueJobAction: async () => ({ ok: true }),
    queueAction: async () => ({ ok: true }),
  };
}

function entry(over: Partial<EntryWithBatch>): EntryWithBatch {
  return {
    id: 'e1',
    batchId: 'b',
    type: 'request',
    familyHash: null,
    content: {},
    tags: [],
    sequence: 0,
    durationMs: 12,
    origin: 'http',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt: '2026-06-03T12:00:00Z',
    batch: [],
    ...over,
  };
}

async function renderDetail(entryValue: EntryWithBatch, traceLink: string | null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const meta: TelescopeMeta = { enabled: true, droppedCount: 0, watchers: [], traceLink };
  const result = render(
    <TelescopeProvider client={mockClient(meta)}>
      <QueryClientProvider client={queryClient}>
        <EntryDetail entry={entryValue} />
      </QueryClientProvider>
    </TelescopeProvider>,
  );
  // let the meta query resolve
  await screen.findByText(entryValue.type);
  return result;
}

describe('EntryDetail trace row', () => {
  it('renders a clickable external link when traceLink is set', async () => {
    await renderDetail(
      entry({ traceId: 'trace-1', spanId: 'span-1' }),
      'https://tracing.example/{traceId}/spans/{spanId}',
    );
    const link = await screen.findByRole('link', { name: 'trace-1' });
    expect(link.getAttribute('href')).toBe('https://tracing.example/trace-1/spans/span-1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
    expect(screen.getByText('span-1')).toBeTruthy();
  });

  it('links to the internal trace page when traceId is present', async () => {
    await renderDetail(entry({ traceId: 'trace-9', spanId: null }), null);
    const link = await screen.findByRole('link', { name: 'View all in this trace' });
    expect(link.getAttribute('href')).toBe('#/traces/trace-9');
  });

  it('renders plain text when traceLink is null', async () => {
    await renderDetail(entry({ traceId: 'trace-2', spanId: 'span-2' }), null);
    expect(screen.queryByRole('link', { name: 'trace-2' })).toBeNull();
    expect(screen.getByText('trace-2')).toBeTruthy();
  });

  it('omits the trace row entirely when traceId is null', async () => {
    await renderDetail(entry({ traceId: null, spanId: null }), 'https://tracing.example/{traceId}');
    expect(screen.queryByText('Trace')).toBeNull();
  });
});
