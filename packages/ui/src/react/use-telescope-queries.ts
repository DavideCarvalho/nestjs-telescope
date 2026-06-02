import { queryOptions, useQuery } from '@tanstack/react-query';
import type { EntriesQuery, TelescopeClient } from '../client/index.js';
import { useTelescopeClient } from './telescope-context.js';

const REFETCH_MS = 3000;

export function entriesQuery(client: TelescopeClient, query: EntriesQuery = {}) {
  return queryOptions({
    queryKey: ['telescope', 'entries', query],
    queryFn: () => client.entries(query),
    refetchInterval: REFETCH_MS,
  });
}
export function entryQuery(client: TelescopeClient, id: string) {
  return queryOptions({ queryKey: ['telescope', 'entry', id], queryFn: () => client.entry(id) });
}
export function pulseQuery(client: TelescopeClient, window: string) {
  return queryOptions({
    queryKey: ['telescope', 'pulse', window],
    queryFn: () => client.pulse(window),
    refetchInterval: REFETCH_MS,
  });
}
export function queuesQuery(client: TelescopeClient, window: string) {
  return queryOptions({
    queryKey: ['telescope', 'queues', window],
    queryFn: () => client.queues(window),
    refetchInterval: REFETCH_MS,
  });
}
export function timeseriesQuery(
  client: TelescopeClient,
  query: { window: string; buckets?: number; type?: string; tag?: string },
) {
  return queryOptions({
    queryKey: ['telescope', 'timeseries', query],
    queryFn: () => client.timeseries(query),
    refetchInterval: REFETCH_MS,
  });
}

export function useEntries(query: EntriesQuery = {}) {
  return useQuery(entriesQuery(useTelescopeClient(), query));
}
export function useEntry(id: string) {
  return useQuery(entryQuery(useTelescopeClient(), id));
}
export function usePulse(window: string) {
  return useQuery(pulseQuery(useTelescopeClient(), window));
}
export function useQueues(window: string) {
  return useQuery(queuesQuery(useTelescopeClient(), window));
}
export function useTimeseries(query: {
  window: string;
  buckets?: number;
  type?: string;
  tag?: string;
}) {
  return useQuery(timeseriesQuery(useTelescopeClient(), query));
}
