import type {
  AuthMeResult,
  AuthMode,
  AuthUser,
  CachedDiagnosis,
  CpuProfileContent,
  DiagnoseResult,
  EntriesQuery,
  Entry,
  EntryWithBatch,
  ExplainResult,
  JobPage,
  LoginResult,
  Page,
  ProfilerStatus,
  PulseReport,
  QueueCapabilities,
  QueueCounts,
  QueueJobDetail,
  QueueMetricsReport,
  QueueState,
  QueueSummary,
  RetentionInfo,
  ScheduledTask,
  ServerStats,
  ServerStatsHistory,
  StatsResult,
  TagCount,
  TelescopeHealth,
  TelescopeMeta,
  TimeseriesQuery,
  TimeseriesReport,
  TracesResult,
  Waterfall,
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

function isAuthMode(value: unknown): value is AuthMode {
  return value === 'session' || value === 'login';
}

/** Derives the API base from the server-injected mount base, falling back to the default. */
function defaultBaseUrl(): string {
  const base = (typeof window !== 'undefined' && window.__TELESCOPE_BASE__) || '/telescope';
  return `${base}/api`;
}

export type JobActionName = 'retry' | 'remove' | 'promote';
export type BulkActionName = 'retry-all' | 'redrive';

export interface TelescopeClient {
  /** The resolved API base URL (e.g. `/telescope/api`). Used by hooks that need to construct URLs directly (e.g. SSE EventSource). */
  readonly baseUrl: string;
  entries(query?: EntriesQuery): Promise<Page<Entry>>;
  entry(id: string): Promise<EntryWithBatch>;
  pulse(window?: string): Promise<PulseReport>;
  queues(window?: string): Promise<QueueMetricsReport>;
  timeseries(query?: TimeseriesQuery): Promise<TimeseriesReport>;
  traces(window?: string, limit?: number): Promise<TracesResult>;
  /** Nested span waterfall for one trace (`GET traces/:traceId/waterfall`). */
  waterfall(traceId: string): Promise<Waterfall>;
  stats(type: string, window: string): Promise<StatsResult>;
  tags(prefix?: string): Promise<TagCount[]>;
  meta(): Promise<TelescopeMeta>;
  /**
   * Fetches data for an extension dashboard panel from a registered provider:
   * `GET ext/:ext/data/:provider`. The optional `query` is serialized to the
   * query string (panel `data.query`). Returns the raw provider payload as
   * `unknown` — the panel renderer (Task 8) narrows it per panel `kind`.
   */
  extData(ext: string, provider: string, query?: Record<string, unknown>): Promise<unknown>;
  serverStats(): Promise<ServerStats>;
  /** CPU/mem history ring buffer for the resource-history card. */
  serverStatsHistory(): Promise<ServerStatsHistory>;
  health(): Promise<TelescopeHealth>;
  /** Retention/prune status for the Overview retention card. */
  retention(): Promise<RetentionInfo>;
  /** Runs on-demand prune (gated server-side by the default-deny mutation guard). */
  prune(): Promise<{ pruned: number }>;
  /**
   * Explains a captured query entry. 404 (no hook / bad entry) and 503 (hook
   * threw) are EXPECTED outcomes surfaced as `{ ok: false }`, not thrown.
   */
  explain(entryId: string): Promise<ExplainResult>;
  /**
   * Diagnoses a captured exception (or client_exception) entry with AI. 404 (AI
   * off / bad entry) and 502 (diagnoser failed) are EXPECTED outcomes surfaced as
   * `{ ok: false }`, not thrown. `force` bypasses the per-family cache.
   */
  diagnose(entryId: string, force?: boolean): Promise<DiagnoseResult>;
  /**
   * Reads the ALREADY-cached AI diagnosis for an exception entry's family, if any
   * (the read-only `GET /exceptions/:id/diagnosis`). NEVER triggers a diagnosis —
   * a cache miss (204) or 404 (AI off / bad entry) both resolve to `null`, so the
   * detail page can show an auto-mode result on open without paying for a model
   * call. Never throws on those expected outcomes.
   */
  cachedDiagnosis(entryId: string): Promise<CachedDiagnosis>;
  /** CPU profiler runtime status (`GET /profiles/status`). */
  profilerStatus(): Promise<ProfilerStatus>;
  /** List captured CPU profiles, newest-first, WITHOUT their frame trees (`GET /profiles`). */
  profiles(limit?: number): Promise<Page<Entry>>;
  /** Fetch one profile's full frame tree (`GET /profiles/:id`). */
  profile(id: string): Promise<Entry & { content: CpuProfileContent }>;
  /**
   * Arm an on-demand capture of the next `count` requests (optionally only those
   * matching `label`). Gated server-side by the default-deny mutation guard.
   */
  armProfile(count: number, label?: string): Promise<{ pendingManual: number }>;
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
  /** Dashboard auth: cookie-backed session, gated behind `dashboardAuth`. */
  auth: {
    /** `GET /auth/me`: 200 user / 401-with-modes / 404 (auth disabled). */
    me(): Promise<AuthMeResult>;
    /** `POST /auth/login`: 204 ok / 401 invalid credentials. */
    login(username: string, password: string): Promise<LoginResult>;
    /** `POST /auth/logout`: clears the session cookie. */
    logout(): Promise<void>;
  };
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

  // Status-aware variants for the auth endpoints, where 401/404 are expected
  // outcomes (which AuthScreen to show / auth disabled) rather than errors —
  // so they must NOT throw the way `get`/`post` do.
  async function rawGet(path: string): Promise<Response> {
    return doFetch(`${baseUrl}${path}`);
  }

  async function rawPost(path: string, body?: unknown): Promise<Response> {
    return doFetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  async function authMe(): Promise<AuthMeResult> {
    const response = await rawGet('/auth/me');
    if (response.ok) {
      const body = (await response.json()) as { user: AuthUser };
      return { status: 'authenticated', user: body.user };
    }
    // 404 => dashboardAuth not configured: proceed as today (no auth screens).
    if (response.status === 404) return { status: 'disabled' };
    // 401 (or anything else) => unauthenticated; read the offered modes.
    const body = await readModesBody(response);
    return { status: 'unauthenticated', modes: body };
  }

  async function readModesBody(response: Response): Promise<AuthMode[]> {
    const parsed = await response
      .json()
      .then((value: unknown) => value)
      .catch(() => null);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'auth' in parsed &&
      parsed.auth !== null &&
      typeof parsed.auth === 'object' &&
      'modes' in parsed.auth &&
      Array.isArray(parsed.auth.modes)
    ) {
      return parsed.auth.modes.filter(isAuthMode);
    }
    return [];
  }

  async function authLogin(username: string, password: string): Promise<LoginResult> {
    const response = await rawPost('/auth/login', { username, password });
    if (response.ok) return { ok: true };
    const message = await readLoginMessage(response);
    return { ok: false, message };
  }

  async function readLoginMessage(response: Response): Promise<string> {
    const parsed = await response
      .json()
      .then((value: unknown) => value)
      .catch(() => null);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'message' in parsed &&
      typeof parsed.message === 'string'
    ) {
      return parsed.message;
    }
    return 'Invalid credentials';
  }

  async function authLogout(): Promise<void> {
    await rawPost('/auth/logout');
  }

  async function explain(entryId: string): Promise<ExplainResult> {
    const response = await rawPost('/queries/explain', { entryId });
    if (response.ok) {
      const body = (await response.json()) as { plan: unknown };
      return { ok: true, plan: body.plan };
    }
    const message = await readExplainMessage(response);
    return { ok: false, message };
  }

  async function readExplainMessage(response: Response): Promise<string> {
    const parsed = await response
      .json()
      .then((value: unknown) => value)
      .catch(() => null);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'message' in parsed &&
      typeof parsed.message === 'string'
    ) {
      return parsed.message;
    }
    return `EXPLAIN failed (${response.status})`;
  }

  async function diagnose(entryId: string, force = false): Promise<DiagnoseResult> {
    const query = force ? '?force=true' : '';
    const response = await rawPost(`/exceptions/${encodeURIComponent(entryId)}/diagnose${query}`);
    if (response.ok) {
      const body = (await response.json()) as { markdown: string; cached: boolean };
      return { ok: true, markdown: body.markdown, cached: body.cached };
    }
    const message = await readDiagnoseMessage(response);
    return { ok: false, message };
  }

  async function cachedDiagnosis(entryId: string): Promise<CachedDiagnosis> {
    const response = await rawGet(`/exceptions/${encodeURIComponent(entryId)}/diagnosis`);
    // 204 (nothing cached) and 404 (AI off / bad entry) are EXPECTED "nothing to
    // show" outcomes — resolve to null rather than throwing. A 204 has no JSON
    // body, so guard on status before parsing.
    if (response.status === 204 || response.status === 404) return null;
    if (!response.ok) return null;
    const body = (await response.json()) as { markdown: string; cached: true };
    return { markdown: body.markdown, cached: true };
  }

  async function readDiagnoseMessage(response: Response): Promise<string> {
    const parsed = await response
      .json()
      .then((value: unknown) => value)
      .catch(() => null);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'message' in parsed &&
      typeof parsed.message === 'string'
    ) {
      return parsed.message;
    }
    return `Diagnosis failed (${response.status})`;
  }

  return {
    baseUrl,
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
    waterfall: (traceId) => get<Waterfall>(`/traces/${encodeURIComponent(traceId)}/waterfall`),
    stats: (type, window) => get<StatsResult>('/stats', { type, window }),
    tags: (prefix) => get<TagCount[]>('/tags', { prefix }),
    meta: () => get<TelescopeMeta>('/meta'),
    extData: (ext, provider, query) => {
      const qs =
        query && Object.keys(query).length
          ? `?${new URLSearchParams(query as Record<string, string>).toString()}`
          : '';
      return get<unknown>(
        `/ext/${encodeURIComponent(ext)}/data/${encodeURIComponent(provider)}${qs}`,
      );
    },
    serverStats: () => get<ServerStats>('/server-stats'),
    serverStatsHistory: () => get<ServerStatsHistory>('/server-stats/history'),
    health: () => get<TelescopeHealth>('/health'),
    retention: () => get<RetentionInfo>('/retention'),
    prune: () => post<{ pruned: number }>('/retention/prune'),
    explain,
    diagnose,
    cachedDiagnosis,
    profilerStatus: () => get<ProfilerStatus>('/profiles/status'),
    profiles: (limit) => get<Page<Entry>>('/profiles', { limit }),
    profile: (id) =>
      get<Entry & { content: CpuProfileContent }>(`/profiles/${encodeURIComponent(id)}`),
    armProfile: (count, label) =>
      post<{ pendingManual: number }>('/profiles/arm', undefined, {
        count,
        ...(label ? { label } : {}),
      }),
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
    auth: {
      me: authMe,
      login: authLogin,
      logout: authLogout,
    },
  };
}
