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

function child(over: Partial<EntryWithBatch>): EntryWithBatch {
  return entry({ type: 'query', batch: [], ...over });
}

// Like renderDetail, but waits on the always-present Batch aside heading — the
// entry `type` text is ambiguous once the batch list renders it per child.
async function renderDetailWithBatch(entryValue: EntryWithBatch) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const meta: TelescopeMeta = { enabled: true, droppedCount: 0, watchers: [], traceLink: null };
  render(
    <TelescopeProvider client={mockClient(meta)}>
      <QueryClientProvider client={queryClient}>
        <EntryDetail entry={entryValue} />
      </QueryClientProvider>
    </TelescopeProvider>,
  );
  await screen.findByText(`Batch (${entryValue.batch.length})`);
}

describe('EntryDetail dump', () => {
  it('renders the dump label and pretty-printed JSON value', async () => {
    await renderDetailWithBatch(
      entry({
        type: 'dump',
        batch: [],
        content: { label: 'my-dump', value: { a: 1, nested: { b: 2 } } },
      }),
    );
    expect(screen.getByText('my-dump')).toBeTruthy();
    // pretty JSON keeps the keys on their own lines
    expect(screen.getByText(/"nested"/)).toBeTruthy();
    expect(screen.getByText(/"b": 2/)).toBeTruthy();
  });

  it('renders the value even when the dump has no label', async () => {
    await renderDetailWithBatch(
      entry({ type: 'dump', batch: [], content: { label: null, value: 'hello' } }),
    );
    expect(screen.getByText('"hello"')).toBeTruthy();
  });
});

describe('EntryDetail request body', () => {
  it('renders headers count, payload JSON, and the user', async () => {
    await renderDetailWithBatch(
      entry({
        type: 'request',
        batch: [],
        content: {
          method: 'POST',
          uri: '/login',
          headers: { 'content-type': 'application/json', accept: '*/*' },
          payload: { email: 'a@b.com' },
          user: { id: 'u1' },
          statusCode: 201,
        },
      }),
    );
    expect(screen.getByText('Headers (2)')).toBeTruthy();
    expect(screen.getByText(/"email": "a@b.com"/)).toBeTruthy();
    expect(screen.getByText(/"id": "u1"/)).toBeTruthy();
  });

  it('renders "anonymous" when the user is null and "No payload" when empty', async () => {
    await renderDetailWithBatch(
      entry({
        type: 'request',
        batch: [],
        content: {
          method: 'GET',
          uri: '/ping',
          headers: {},
          payload: null,
          user: null,
          statusCode: 200,
        },
      }),
    );
    expect(screen.getByText('anonymous')).toBeTruthy();
    expect(screen.getByText('No payload')).toBeTruthy();
    expect(screen.getByText('Headers (0)')).toBeTruthy();
  });
});

describe('EntryDetail request timeline', () => {
  it('renders the timeline for a request with batch children beyond itself', async () => {
    const self = child({
      id: 'req',
      type: 'request',
      sequence: 0,
      durationMs: 40,
      content: { method: 'GET', uri: '/users' },
    });
    const query = child({
      id: 'q1',
      type: 'query',
      sequence: 1,
      durationMs: 10,
      content: { sql: 'select 1' },
    });
    await renderDetailWithBatch(
      entry({
        id: 'req',
        type: 'request',
        durationMs: 40,
        content: { method: 'GET', uri: '/users' },
        batch: [self, query],
      }),
    );
    expect(screen.getByText('Timeline')).toBeTruthy();
    // the child query's label renders inside the timeline (also echoed in the Batch aside)
    expect(screen.getAllByText('select 1').length).toBeGreaterThan(0);
  });

  it('does not render the timeline for a non-request entry', async () => {
    await renderDetailWithBatch(
      entry({ type: 'query', batch: [child({ id: 'a' }), child({ id: 'b' })] }),
    );
    expect(screen.queryByText('Timeline')).toBeNull();
  });

  it('does not render the timeline for a request with no children beyond itself', async () => {
    await renderDetailWithBatch(
      entry({ id: 'solo', type: 'request', batch: [child({ id: 'solo', type: 'request' })] }),
    );
    expect(screen.queryByText('Timeline')).toBeNull();
  });
});
