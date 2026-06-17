// packages/ui/test/react/use-telescope-stream.spec.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TelescopeClient } from '../../src/client/index.js';
import { TelescopeProvider } from '../../src/react/telescope-context.js';
import { useTelescopeStream } from '../../src/react/use-telescope-stream.js';

class FakeES {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  close = vi.fn();
  constructor(public url: string) {
    (FakeES as any).last = this;
  }
}

afterEach(() => vi.unstubAllGlobals());

function makeClient(baseUrl = '/telescope/api'): TelescopeClient {
  return {
    baseUrl,
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
    traces: async () => {
      throw new Error('not used');
    },
    stats: async () => {
      throw new Error('not used');
    },
    tags: async () => [],
    meta: async () => ({
      enabled: true,
      droppedCount: 0,
      watchers: [],
      traceLink: null,
      retention: null,
      sampling: {},
    }),
    extData: async () => null,
    serverStats: async () => {
      throw new Error('not used');
    },
    health: async () => {
      throw new Error('not used');
    },
    retention: async () => {
      throw new Error('not used');
    },
    prune: async () => ({ pruned: 0 }),
    explain: async () => ({ ok: false, message: '' }),
    diagnose: async () => ({ ok: false, message: '' }),
    cachedDiagnosis: async () => null,
    liveQueues: async () => {
      throw new Error('not used');
    },
    schedulesLive: async () => {
      throw new Error('not used');
    },
    queueCounts: async () => {
      throw new Error('not used');
    },
    queueJobs: async () => {
      throw new Error('not used');
    },
    queueJob: async () => null,
    queueJobAction: async () => ({ ok: true }),
    queueAction: async () => ({ ok: true }),
    queueEnqueue: async () => ({ id: null }),
    auth: {
      me: async () => ({ status: 'disabled' }),
      login: async () => ({ ok: true }),
      logout: async () => {},
    },
  };
}

describe('useTelescopeStream', () => {
  it('invalidates ext-data queries on a types tick', async () => {
    vi.stubGlobal('EventSource', FakeES);
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const client = makeClient('/telescope/api');
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>
        <TelescopeProvider client={client}>{children}</TelescopeProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useTelescopeStream(), { wrapper });
    const es = (FakeES as any).last as FakeES;
    // URL must end in /api/stream (baseUrl-agnostic assertion)
    expect(es.url).toMatch(/\/api\/stream$/);
    es.onopen?.();
    await waitFor(() => expect(result.current.status).toBe('live'));
    es.onmessage?.({ data: JSON.stringify({ types: ['durable'] }) });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['telescope', 'ext-data'] });
  });

  it('sets status to polling on EventSource error', async () => {
    vi.stubGlobal('EventSource', FakeES);
    const qc = new QueryClient();
    const client = makeClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>
        <TelescopeProvider client={client}>{children}</TelescopeProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useTelescopeStream(), { wrapper });
    const es = (FakeES as any).last as FakeES;
    es.onerror?.();
    await waitFor(() => expect(result.current.status).toBe('polling'));
  });

  it('ignores heartbeat messages', async () => {
    vi.stubGlobal('EventSource', FakeES);
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const client = makeClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>
        <TelescopeProvider client={client}>{children}</TelescopeProvider>
      </QueryClientProvider>
    );
    renderHook(() => useTelescopeStream(), { wrapper });
    const es = (FakeES as any).last as FakeES;
    es.onmessage?.({ data: JSON.stringify({ heartbeat: true }) });
    expect(spy).not.toHaveBeenCalled();
  });

  it('falls back to polling when EventSource is undefined (SSR)', () => {
    // EventSource is NOT stubbed — behaves like SSR environment
    const original = (globalThis as Record<string, unknown>).EventSource;
    (globalThis as Record<string, unknown>).EventSource = undefined;
    const qc = new QueryClient();
    const client = makeClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>
        <TelescopeProvider client={client}>{children}</TelescopeProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useTelescopeStream(), { wrapper });
    expect(result.current.status).toBe('polling');
    if (original !== undefined) {
      (globalThis as Record<string, unknown>).EventSource = original;
    }
  });
});
