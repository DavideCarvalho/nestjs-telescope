import type {
  EntriesQuery,
  Entry,
  EntryWithBatch,
  Page,
  PulseReport,
  QueueMetricsReport,
  TelescopeMeta,
  TimeseriesQuery,
  TimeseriesReport,
} from './types.js';

export interface TelescopeClientOptions {
  /** Base URL of the telescope API. Default '/telescope/api'. */
  baseUrl?: string;
  /** Fetch implementation (injectable for tests). Default global fetch. */
  fetch?: typeof globalThis.fetch;
}

export interface TelescopeClient {
  entries(query?: EntriesQuery): Promise<Page<Entry>>;
  entry(id: string): Promise<EntryWithBatch>;
  pulse(window?: string): Promise<PulseReport>;
  queues(window?: string): Promise<QueueMetricsReport>;
  timeseries(query?: TimeseriesQuery): Promise<TimeseriesReport>;
  meta(): Promise<TelescopeMeta>;
}

export function createTelescopeClient(options: TelescopeClientOptions = {}): TelescopeClient {
  const baseUrl = (options.baseUrl ?? '/telescope/api').replace(/\/$/, '');
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

  return {
    entries: (query = {}) =>
      get<Page<Entry>>('/entries', {
        type: query.type,
        tag: query.tag,
        batchId: query.batchId,
        familyHash: query.familyHash,
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
    meta: () => get<TelescopeMeta>('/meta'),
  };
}
