import type {
  EntriesQuery,
  Entry,
  EntryWithBatch,
  JobPage,
  Page,
  PulseReport,
  QueueCapabilities,
  QueueCounts,
  QueueJobDetail,
  QueueMetricsReport,
  QueueState,
  QueueSummary,
  ScheduledTask,
  StatsResult,
  TagCount,
  TelescopeMeta,
  TimeseriesQuery,
  TimeseriesReport,
  TracesResult,
} from './types.js';

declare global {
  interface Window {
    /**
     * Mount base (e.g. `/observability`) injected by the UI controller's
     * index.html when the dashboard is served under a custom path. Absent on the
     * default mount and in SSR/tests, where the API base falls back to
     * `/telescope/api`.
     */
    __TELESCOPE_BASE__?: string;
  }
}

export interface TelescopeClientOptions {
  /** Base URL of the telescope API. Default '/telescope/api' (or `${window.__TELESCOPE_BASE__}/api`). */
  baseUrl?: string;
  /** Fetch implementation (injectable for tests). Default global fetch. */
  fetch?: typeof globalThis.fetch;
}

/** Derives the API base from the server-injected mount base, falling back to the default. */
function defaultBaseUrl(): string {
  const base = (typeof window !== 'undefined' && window.__TELESCOPE_BASE__) || '/telescope';
  return `${base}/api`;
}

export type JobActionName = 'retry' | 'remove' | 'promote';
export type BulkActionName = 'retry-all' | 'redrive';

export interface TelescopeClient {
  entries(query?: EntriesQuery): Promise<Page<Entry>>;
  entry(id: string): Promise<EntryWithBatch>;
  pulse(window?: string): Promise<PulseReport>;
  queues(window?: string): Promise<QueueMetricsReport>;
  timeseries(query?: TimeseriesQuery): Promise<TimeseriesReport>;
  traces(window?: string, limit?: number): Promise<TracesResult>;
  stats(type: string, window: string): Promise<StatsResult>;
  tags(prefix?: string): Promise<TagCount[]>;
  meta(): Promise<TelescopeMeta>;
  liveQueues(): Promise<{ queues: QueueSummary[]; capabilities: QueueCapabilities }>;
  schedulesLive(): Promise<{ tasks: ScheduledTask[] }>;
  queueCounts(driver: string, queue: string): Promise<QueueCounts>;
  queueJobs(
    driver: string,
    queue: string,
    state: QueueState,
    page?: { cursor?: string; limit?: number },
  ): Promise<JobPage>;
  queueJob(driver: string, queue: string, id: string): Promise<QueueJobDetail | null>;
  queueJobAction(
    driver: string,
    queue: string,
    id: string,
    action: JobActionName,
  ): Promise<{ ok: true }>;
  queueAction(
    driver: string,
    queue: string,
    action: BulkActionName,
    opts?: { state?: QueueState },
  ): Promise<{ ok: true; count?: number }>;
  queueEnqueue(
    driver: string,
    queue: string,
    body: { name?: string; payload: unknown },
  ): Promise<{ id: string | null }>;
}

export function createTelescopeClient(options: TelescopeClientOptions = {}): TelescopeClient {
  const baseUrl = (options.baseUrl ?? defaultBaseUrl()).replace(/\/$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;

  async function get<T>(
    path: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<T> {
    let url = `${baseUrl}${path}`;
    if (params) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) search.set(key, String(value));
      }
      const qs = search.toString();
      if (qs) url += `?${qs}`;
    }
    const response = await doFetch(url);
    if (!response.ok) throw new Error(`Telescope API ${path} failed: ${response.status}`);
    return (await response.json()) as T;
  }

  async function post<T>(
    path: string,
    params?: Record<string, string | number | undefined>,
    body?: unknown,
  ): Promise<T> {
    let url = `${baseUrl}${path}`;
    if (params) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) search.set(key, String(value));
      }
      const qs = search.toString();
      if (qs) url += `?${qs}`;
    }
    const response = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`Telescope API ${path} failed: ${response.status}`);
    return (await response.json()) as T;
  }

  return {
    entries: (query = {}) =>
      get<Page<Entry>>('/entries', {
        type: query.type,
        tag: query.tag,
        traceId: query.traceId,
        batchId: query.batchId,
        familyHash: query.familyHash,
        search: query.search,
        cursor: query.cursor,
        limit: query.limit,
      }),
    entry: (id) => get<EntryWithBatch>(`/entries/${encodeURIComponent(id)}`),
    pulse: (window) => get<PulseReport>('/pulse', { window }),
    queues: (window) => get<QueueMetricsReport>('/queues', { window }),
    timeseries: (query = {}) =>
      get<TimeseriesReport>('/timeseries', {
        window: query.window,
        buckets: query.buckets,
        type: query.type,
        tag: query.tag,
      }),
    traces: (window, limit) => get<TracesResult>('/traces', { window, limit }),
    stats: (type, window) => get<StatsResult>('/stats', { type, window }),
    tags: (prefix) => get<TagCount[]>('/tags', { prefix }),
    meta: () => get<TelescopeMeta>('/meta'),
    liveQueues: () =>
      get<{ queues: QueueSummary[]; capabilities: QueueCapabilities }>('/queues/live'),
    schedulesLive: () => get<{ tasks: ScheduledTask[] }>('/schedules/live'),
    queueCounts: (driver, queue) =>
      get<QueueCounts>(
        `/queues/live/${encodeURIComponent(driver)}/${encodeURIComponent(queue)}/counts`,
      ),
    queueJobs: (driver, queue, state, page = {}) =>
      get<JobPage>(`/queues/live/${encodeURIComponent(driver)}/${encodeURIComponent(queue)}/jobs`, {
        state,
        cursor: page.cursor,
        limit: page.limit,
      }),
    queueJob: (driver, queue, id) =>
      get<QueueJobDetail | null>(
        `/queues/live/${encodeURIComponent(driver)}/${encodeURIComponent(queue)}/jobs/${encodeURIComponent(id)}`,
      ),
    queueJobAction: (driver, queue, id, action) =>
      post<{ ok: true }>(
        `/queues/live/${encodeURIComponent(driver)}/${encodeURIComponent(queue)}/jobs/${encodeURIComponent(id)}/${encodeURIComponent(action)}`,
      ),
    queueAction: (driver, queue, action, opts = {}) =>
      post<{ ok: true; count?: number }>(
        `/queues/live/${encodeURIComponent(driver)}/${encodeURIComponent(queue)}/actions/${encodeURIComponent(action)}`,
        { state: opts.state },
      ),
    queueEnqueue: (driver, queue, body) =>
      post<{ id: string | null }>(
        `/queues/live/${encodeURIComponent(driver)}/${encodeURIComponent(queue)}/enqueue`,
        undefined,
        body,
      ),
  };
}
