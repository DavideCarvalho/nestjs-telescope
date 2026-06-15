import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BulkActionName,
  EntriesQuery,
  JobActionName,
  QueueState,
  TelescopeClient,
} from '../client/index.js';
import { usePaused, useTelescopeClient } from './telescope-context.js';

export const REFETCH_MS = 3000;
export const LIVE_REFETCH_MS = 2500;

// Live-tail gate: when paused, the dashboard freezes by disabling every interval.
function intervalWhenLive(ms: number, paused: boolean): number | false {
  return paused ? false : ms;
}

export function entriesQuery(client: TelescopeClient, query: EntriesQuery = {}, paused = false) {
  return queryOptions({
    queryKey: ['telescope', 'entries', query],
    queryFn: () => client.entries(query),
    refetchInterval: intervalWhenLive(REFETCH_MS, paused),
  });
}
export function entryQuery(client: TelescopeClient, id: string) {
  return queryOptions({ queryKey: ['telescope', 'entry', id], queryFn: () => client.entry(id) });
}
// Tags are reference data for the filter autocomplete — no live-tail polling;
// React Query caches per prefix so repeated keystrokes don't refetch.
export function tagsQuery(client: TelescopeClient, prefix = '') {
  return queryOptions({
    queryKey: ['telescope', 'tags', prefix],
    queryFn: () => client.tags(prefix === '' ? undefined : prefix),
    staleTime: REFETCH_MS,
  });
}
export function metaQuery(client: TelescopeClient, paused = false) {
  return queryOptions({
    queryKey: ['telescope', 'meta'],
    queryFn: () => client.meta(),
    refetchInterval: intervalWhenLive(REFETCH_MS, paused),
  });
}
// Extension panel data — fetched per (ext, provider, query) for dashboard panels.
// No live-tail polling here; the dashboard page (Task 9) opts panels into
// refetch as needed. React Query caches per query key so identical panels share.
export function extDataQuery(
  client: TelescopeClient,
  ext: string,
  provider: string,
  query?: Record<string, unknown>,
) {
  return queryOptions({
    queryKey: ['telescope', 'ext-data', ext, provider, query],
    queryFn: () => client.extData(ext, provider, query),
  });
}
export function serverStatsQuery(client: TelescopeClient, paused = false) {
  return queryOptions({
    queryKey: ['telescope', 'server-stats'],
    queryFn: () => client.serverStats(),
    refetchInterval: intervalWhenLive(REFETCH_MS, paused),
  });
}
export function healthQuery(client: TelescopeClient, paused = false) {
  return queryOptions({
    queryKey: ['telescope', 'health'],
    queryFn: () => client.health(),
    refetchInterval: intervalWhenLive(REFETCH_MS, paused),
  });
}
export function retentionKey() {
  return ['telescope', 'retention'] as const;
}
export function retentionQuery(client: TelescopeClient, paused = false) {
  return queryOptions({
    queryKey: retentionKey(),
    queryFn: () => client.retention(),
    refetchInterval: intervalWhenLive(REFETCH_MS, paused),
  });
}
export function pulseQuery(client: TelescopeClient, window: string, paused = false) {
  return queryOptions({
    queryKey: ['telescope', 'pulse', window],
    queryFn: () => client.pulse(window),
    refetchInterval: intervalWhenLive(REFETCH_MS, paused),
  });
}
export function statsQuery(client: TelescopeClient, type: string, window: string, paused = false) {
  return queryOptions({
    queryKey: ['telescope', 'stats', type, window],
    queryFn: () => client.stats(type, window),
    refetchInterval: intervalWhenLive(REFETCH_MS, paused),
  });
}
export function queuesQuery(client: TelescopeClient, window: string, paused = false) {
  return queryOptions({
    queryKey: ['telescope', 'queues', window],
    queryFn: () => client.queues(window),
    refetchInterval: intervalWhenLive(REFETCH_MS, paused),
  });
}
export function timeseriesQuery(
  client: TelescopeClient,
  query: { window: string; buckets?: number; type?: string; tag?: string },
  paused = false,
) {
  return queryOptions({
    queryKey: ['telescope', 'timeseries', query],
    queryFn: () => client.timeseries(query),
    refetchInterval: intervalWhenLive(REFETCH_MS, paused),
  });
}

export function tracesQuery(
  client: TelescopeClient,
  window: string,
  limit?: number,
  paused = false,
) {
  return queryOptions({
    queryKey: ['telescope', 'traces', window, limit],
    queryFn: () => client.traces(window, limit),
    refetchInterval: intervalWhenLive(REFETCH_MS, paused),
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

export function liveQueuesQuery(client: TelescopeClient, paused = false) {
  return queryOptions({
    queryKey: liveQueuesKey(),
    queryFn: () => client.liveQueues(),
    refetchInterval: intervalWhenLive(LIVE_REFETCH_MS, paused),
  });
}
export function queueJobsQuery(
  client: TelescopeClient,
  driver: string,
  queue: string,
  state: QueueState,
  page: { cursor?: string; limit?: number } = {},
  paused = false,
) {
  return queryOptions({
    queryKey: queueJobsKey(driver, queue, state, page),
    queryFn: () => client.queueJobs(driver, queue, state, page),
    refetchInterval: intervalWhenLive(LIVE_REFETCH_MS, paused),
  });
}
export function queueJobQuery(client: TelescopeClient, driver: string, queue: string, id: string) {
  return queryOptions({
    queryKey: queueJobKey(driver, queue, id),
    queryFn: () => client.queueJob(driver, queue, id),
  });
}

// --- live schedules ---
export function schedulesLiveKey() {
  return ['telescope', 'live-schedules'] as const;
}
export function schedulesLiveQuery(client: TelescopeClient, paused = false) {
  return queryOptions({
    queryKey: schedulesLiveKey(),
    queryFn: () => client.schedulesLive(),
    refetchInterval: intervalWhenLive(LIVE_REFETCH_MS, paused),
  });
}

export function useLiveQueues() {
  return useQuery(liveQueuesQuery(useTelescopeClient(), usePaused()));
}
export function useSchedulesLive() {
  return useQuery(schedulesLiveQuery(useTelescopeClient(), usePaused()));
}
export function useQueueJobs(
  driver: string,
  queue: string,
  state: QueueState,
  page: { cursor?: string; limit?: number } = {},
) {
  return useQuery(queueJobsQuery(useTelescopeClient(), driver, queue, state, page, usePaused()));
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

interface EnqueueVars {
  driver: string;
  queue: string;
  name?: string;
  payload: unknown;
}

export function useQueueEnqueue() {
  const client = useTelescopeClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: EnqueueVars) =>
      client.queueEnqueue(vars.driver, vars.queue, {
        ...(vars.name !== undefined ? { name: vars.name } : {}),
        payload: vars.payload,
      }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: liveQueuesKey() });
      queryClient.invalidateQueries({ queryKey: queueCountsKey(vars.driver, vars.queue) });
      queryClient.invalidateQueries({
        queryKey: ['telescope', 'queue-jobs', vars.driver, vars.queue],
      });
    },
  });
}

export function useRetention() {
  return useQuery(retentionQuery(useTelescopeClient(), usePaused()));
}

export function usePrune() {
  const client = useTelescopeClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => client.prune(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: retentionKey() });
      queryClient.invalidateQueries({ queryKey: ['telescope', 'entries'] });
    },
  });
}

export function useExplain() {
  const client = useTelescopeClient();
  return useMutation({ mutationFn: (entryId: string) => client.explain(entryId) });
}

interface DiagnoseVars {
  entryId: string;
  /** Bypass the per-family cache and force a fresh diagnosis. */
  force?: boolean;
}

export function useDiagnose() {
  const client = useTelescopeClient();
  return useMutation({
    mutationFn: (vars: DiagnoseVars) => client.diagnose(vars.entryId, vars.force ?? false),
  });
}

/**
 * Query options for the read-only cached-diagnosis lookup. `enabled` lets the
 * caller gate the fetch on `meta.ai.enabled` so we never even ask when AI is off.
 * No polling — a diagnosis, once cached, is stable for the page's lifetime; the
 * Re-run mutation invalidates this key to refresh after a forced re-diagnosis.
 */
export function cachedDiagnosisQuery(client: TelescopeClient, entryId: string, enabled: boolean) {
  return queryOptions({
    queryKey: ['telescope', 'cached-diagnosis', entryId],
    queryFn: () => client.cachedDiagnosis(entryId),
    enabled,
  });
}

export function useCachedDiagnosis(entryId: string, enabled: boolean) {
  return useQuery(cachedDiagnosisQuery(useTelescopeClient(), entryId, enabled));
}

export function useEntries(query: EntriesQuery = {}) {
  return useQuery(entriesQuery(useTelescopeClient(), query, usePaused()));
}
export function useEntry(id: string) {
  return useQuery(entryQuery(useTelescopeClient(), id));
}
export function useMeta() {
  return useQuery(metaQuery(useTelescopeClient(), usePaused()));
}
export function useServerStats() {
  return useQuery(serverStatsQuery(useTelescopeClient(), usePaused()));
}
export function useExtensionData(
  ext: string,
  provider: string,
  query?: Record<string, unknown>,
) {
  return useQuery(extDataQuery(useTelescopeClient(), ext, provider, query));
}
export function useHealth() {
  return useQuery(healthQuery(useTelescopeClient(), usePaused()));
}
export function useTags(prefix = '') {
  return useQuery(tagsQuery(useTelescopeClient(), prefix));
}
export function useStats(type: string, window: string) {
  return useQuery(statsQuery(useTelescopeClient(), type, window, usePaused()));
}
export function usePulse(window: string) {
  return useQuery(pulseQuery(useTelescopeClient(), window, usePaused()));
}
export function useQueues(window: string) {
  return useQuery(queuesQuery(useTelescopeClient(), window, usePaused()));
}
export function useTimeseries(query: {
  window: string;
  buckets?: number;
  type?: string;
  tag?: string;
}) {
  return useQuery(timeseriesQuery(useTelescopeClient(), query, usePaused()));
}
export function useTraces(window: string, limit?: number) {
  return useQuery(tracesQuery(useTelescopeClient(), window, limit, usePaused()));
}
