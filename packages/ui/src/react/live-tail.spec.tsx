import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TelescopeClient } from '../client/index.js';
import { TelescopeProvider, useLiveTail } from './telescope-context.js';
import {
  REFETCH_MS,
  entriesQuery,
  liveQueuesQuery,
  metaQuery,
  pulseQuery,
} from './use-telescope-queries.js';

function mockClient(): TelescopeClient {
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
    meta: async () => ({
      enabled: true,
      droppedCount: 0,
      watchers: [],
      traceLink: null,
      retention: null,
      sampling: {},
    }),
  };
}

describe('live-tail query gating', () => {
  it('polls at REFETCH_MS when live and disables the interval when paused', () => {
    const client = mockClient();
    expect(entriesQuery(client, {}, false).refetchInterval).toBe(REFETCH_MS);
    expect(entriesQuery(client, {}, true).refetchInterval).toBe(false);
    expect(metaQuery(client, true).refetchInterval).toBe(false);
    expect(pulseQuery(client, '1h', true).refetchInterval).toBe(false);
    expect(liveQueuesQuery(client, true).refetchInterval).toBe(false);
  });

  it('defaults to live (not paused) when unset', () => {
    const client = mockClient();
    expect(entriesQuery(client).refetchInterval).toBe(REFETCH_MS);
    expect(metaQuery(client).refetchInterval).toBe(REFETCH_MS);
  });
});

describe('useLiveTail', () => {
  it('defaults to not paused and exposes a setter', () => {
    const { result } = renderHook(() => useLiveTail(), {
      wrapper: ({ children }) => (
        <TelescopeProvider client={mockClient()}>{children}</TelescopeProvider>
      ),
    });
    expect(result.current.paused).toBe(false);
    expect(typeof result.current.setPaused).toBe('function');
  });
});
