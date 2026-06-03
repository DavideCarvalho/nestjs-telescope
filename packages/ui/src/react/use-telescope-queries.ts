import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BulkActionName,
  EntriesQuery,
  JobActionName,
  QueueState,
  TelescopeClient,
} from '../client/index.js';
import { useTelescopeClient } from './telescope-context.js';

const REFETCH_MS = 3000;
const LIVE_REFETCH_MS = 2500;

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
export function metaQuery(client: TelescopeClient) {
  return queryOptions({
    queryKey: ['telescope', 'meta'],
    queryFn: () => client.meta(),
    refetchInterval: REFETCH_MS,
  });
}
export function pulseQuery(client: TelescopeClient, window: string) {
  return queryOptions({
    queryKey: ['telescope', 'pulse', window],
    queryFn: () => client.pulse(window),
    refetchInterval: REFETCH_MS,
  });
}
export function statsQuery(client: TelescopeClient, type: string, window: string) {
  return queryOptions({
    queryKey: ['telescope', 'stats', type, window],
    queryFn: () => client.stats(type, window),
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

// --- live queue query keys (stable, shared by queries + mutation invalidation) ---
export function liveQueuesKey() {
  return ['telescope', 'live-queues'] as const;
}
export function queueCountsKey(driver: string, queue: string) {
  return ['telescope', 'queue-counts', driver, queue] as const;
}
export function queueJobsKey(
  driver: string,
  queue: string,
  state: QueueState,
  page: { cursor?: string; limit?: number } = {},
) {
  return ['telescope', 'queue-jobs', driver, queue, state, page] as const;
}
export function queueJobKey(driver: string, queue: string, id: string) {
  return ['telescope', 'queue-job', driver, queue, id] as const;
}

export function liveQueuesQuery(client: TelescopeClient) {
  return queryOptions({
    queryKey: liveQueuesKey(),
    queryFn: () => client.liveQueues(),
    refetchInterval: LIVE_REFETCH_MS,
  });
}
export function queueJobsQuery(
  client: TelescopeClient,
  driver: string,
  queue: string,
  state: QueueState,
  page: { cursor?: string; limit?: number } = {},
) {
  return queryOptions({
    queryKey: queueJobsKey(driver, queue, state, page),
    queryFn: () => client.queueJobs(driver, queue, state, page),
    refetchInterval: LIVE_REFETCH_MS,
  });
}
export function queueJobQuery(client: TelescopeClient, driver: string, queue: string, id: string) {
  return queryOptions({
    queryKey: queueJobKey(driver, queue, id),
    queryFn: () => client.queueJob(driver, queue, id),
  });
}

export function useLiveQueues() {
  return useQuery(liveQueuesQuery(useTelescopeClient()));
}
export function useQueueJobs(
  driver: string,
  queue: string,
  state: QueueState,
  page: { cursor?: string; limit?: number } = {},
) {
  return useQuery(queueJobsQuery(useTelescopeClient(), driver, queue, state, page));
}
export function useQueueJob(driver: string, queue: string, id: string) {
  return useQuery(queueJobQuery(useTelescopeClient(), driver, queue, id));
}

interface JobActionVars {
  driver: string;
  queue: string;
  id: string;
  action: JobActionName;
}

export function useQueueJobAction() {
  const client = useTelescopeClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: JobActionVars) =>
      client.queueJobAction(vars.driver, vars.queue, vars.id, vars.action),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: queueCountsKey(vars.driver, vars.queue) });
      queryClient.invalidateQueries({
        queryKey: ['telescope', 'queue-jobs', vars.driver, vars.queue],
      });
    },
  });
}

interface BulkActionVars {
  driver: string;
  queue: string;
  action: BulkActionName;
  state?: QueueState;
}

export function useQueueAction() {
  const client = useTelescopeClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: BulkActionVars) =>
      client.queueAction(
        vars.driver,
        vars.queue,
        vars.action,
        vars.state !== undefined ? { state: vars.state } : {},
      ),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: queueCountsKey(vars.driver, vars.queue) });
      queryClient.invalidateQueries({
        queryKey: ['telescope', 'queue-jobs', vars.driver, vars.queue],
      });
    },
  });
}

export function useEntries(query: EntriesQuery = {}) {
  return useQuery(entriesQuery(useTelescopeClient(), query));
}
export function useEntry(id: string) {
  return useQuery(entryQuery(useTelescopeClient(), id));
}
export function useMeta() {
  return useQuery(metaQuery(useTelescopeClient()));
}
export function useStats(type: string, window: string) {
  return useQuery(statsQuery(useTelescopeClient(), type, window));
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
