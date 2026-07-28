import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TelescopeClient, TelescopeMeta } from '../../client/index.js';
import { TelescopeProvider } from '../telescope-context.js';
import { RetentionIndicator, formatRetention, samplingNote } from './retention-indicator.js';

function mockClient(meta: TelescopeMeta): TelescopeClient {
  const unused = async (): Promise<never> => {
    throw new Error('not used');
  };
  return {
    baseUrl: '',
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
    traces: unused,
    waterfall: unused,
    stats: async () => {
      throw new Error('not used');
    },
    tags: unused,
    meta: async () => meta,
    extData: unused,
    serverStats: unused,
    serverStatsHistory: unused,
    health: unused,
    retention: unused,
    prunes: unused,
    prune: unused,
    explain: unused,
    diagnose: unused,
    cachedDiagnosis: unused,
    profilerStatus: unused,
    profiles: unused,
    profile: unused,
    armProfile: unused,
    liveQueues: unused,
    schedulesLive: unused,
    queueCounts: unused,
    queueJobs: unused,
    queueJob: unused,
    queueJobAction: unused,
    queueAction: unused,
    queueEnqueue: unused,
    auth: {
      me: unused,
      login: unused,
      logout: unused,
    },
  };
}

function meta(over: Partial<TelescopeMeta>): TelescopeMeta {
  return {
    enabled: true,
    droppedCount: 0,
    watchers: [],
    traceLink: null,
    retention: null,
    pruneEnabled: false,
    explainEnabled: false,
    auth: { enabled: false, modes: [] },
    sampling: {},
    ...over,
  };
}

async function renderIndicator(metaValue: TelescopeMeta) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <TelescopeProvider client={mockClient(metaValue)}>
      <QueryClientProvider client={queryClient}>
        <RetentionIndicator />
      </QueryClientProvider>
    </TelescopeProvider>,
  );
}

describe('formatRetention', () => {
  it('formats ms to short human strings', () => {
    expect(formatRetention(500)).toBe('500ms');
    expect(formatRetention(30_000)).toBe('30s');
    expect(formatRetention(5 * 60_000)).toBe('5m');
    expect(formatRetention(60 * 60_000)).toBe('1h');
    expect(formatRetention(2 * 24 * 60 * 60_000)).toBe('2d');
  });
});

describe('samplingNote', () => {
  it('reports the first type sampled below 1', () => {
    expect(samplingNote({ request: 0.25 })).toBe('request sampled @ 25%');
  });

  it('returns null when nothing is sampled below 1', () => {
    expect(samplingNote({ request: 1, query: 1 })).toBeNull();
    expect(samplingNote({})).toBeNull();
  });
});

describe('RetentionIndicator', () => {
  it('shows the formatted retention window', async () => {
    await renderIndicator(meta({ retention: { afterMs: 5 * 60_000, keepLast: null } }));
    expect(await screen.findByText('5m')).toBeTruthy();
  });

  it('shows "none" when retention is null', async () => {
    await renderIndicator(meta({ retention: null }));
    expect(await screen.findByText('none')).toBeTruthy();
  });

  it('renders a sampling note when a rate is below 1', async () => {
    await renderIndicator(
      meta({ retention: { afterMs: 60 * 60_000, keepLast: null }, sampling: { request: 0.25 } }),
    );
    expect(await screen.findByLabelText('request sampled @ 25%')).toBeTruthy();
  });
});
