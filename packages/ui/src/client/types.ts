export type {
  JobPage,
  QueueActionName,
  QueueCounts,
  QueueJob,
  QueueJobDetail,
  QueueState,
  QueueSummary,
  ScheduledTask,
  ScheduleKind,
  ScheduleRunStatus,
} from '@dudousxd/nestjs-telescope';
import type { QueueActionName } from '@dudousxd/nestjs-telescope';

/** Capability hints returned alongside the live queue list. */
export interface QueueCapabilities {
  mutationsEnabled: boolean;
  actionsByDriver: Record<string, QueueActionName[]>;
}

export interface Entry {
  id: string;
  batchId: string;
  type: string;
  familyHash: string | null;
  content: unknown;
  tags: string[];
  sequence: number;
  durationMs: number | null;
  origin: string;
  instanceId: string;
  traceId: string | null;
  spanId: string | null;
  createdAt: string;
}
export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}
export interface EntryWithBatch extends Entry {
  batch: Entry[];
}
export interface EntriesQuery {
  type?: string;
  tag?: string;
  traceId?: string;
  batchId?: string;
  familyHash?: string;
  /** Case-insensitive substring matched against the entry's content. */
  search?: string;
  cursor?: string;
  limit?: number;
}
/** A distinct tag and how many entries carry it. Returned by `GET /tags`. */
export interface TagCount {
  tag: string;
  count: number;
}
/** Which AuthScreen the unauthenticated SPA should render. */
export type AuthMode = 'session' | 'login';

/** The authenticated dashboard user, as returned by `GET /auth/me`. */
export interface AuthUser {
  id: string;
  name?: string;
  roles?: string[];
}

/**
 * Outcome of `GET /auth/me`, modeled as a discriminated union so the boot gate
 * can branch exhaustively:
 * - `authenticated`: a valid session cookie was present (200 + user).
 * - `unauthenticated`: no/invalid cookie (401); `modes` tells the SPA which
 *   AuthScreen to show.
 * - `disabled`: `dashboardAuth` is not configured on the host (404) — the SPA
 *   proceeds exactly as it does without auth.
 */
export type AuthMeResult =
  | { status: 'authenticated'; user: AuthUser }
  | { status: 'unauthenticated'; modes: AuthMode[] }
  | { status: 'disabled' };

/** Outcome of `POST /auth/login`. */
export type LoginResult = { ok: true } | { ok: false; message: string };

/** Threshold coloring for a numeric panel. `direction` says which way is worse. */
export interface PanelThresholds {
  warn: number;
  bad: number;
  direction: 'up-bad' | 'down-bad';
}

/** A group of panels rendered together with its own column count. */
export interface DashboardSection {
  title?: string;
  cols?: 2 | 3 | 4;
  panels: Panel[];
}

/**
 * A single dashboard panel descriptor, mirrored on the UI side from the core
 * `Panel` extension contract. Kept UI-local (rather than imported from
 * `@dudousxd/nestjs-telescope`) so the UI package has no value/type dependency
 * on the core — the dashboard renderer (Task 8) consumes this shape verbatim.
 * Each variant carries a `data` provider reference resolved via
 * {@link TelescopeClient.extData}.
 */
export type Panel =
  | {
      kind: 'stat';
      title: string;
      data: { provider: string; query?: Record<string, unknown> };
      format?: 'number' | 'percent' | 'duration' | 'rate';
      accent?: string;
      /** When true, the provider also returns `spark: number[]` and the card draws a sparkline. */
      spark?: boolean;
      thresholds?: PanelThresholds;
    }
  | {
      kind: 'timeseries';
      title: string;
      data: { provider: string; query?: Record<string, unknown> };
      series: string[];
      style?: 'area' | 'stacked';
    }
  | {
      kind: 'topN';
      title: string;
      data: { provider: string; query?: Record<string, unknown> };
      limit?: number;
    }
  | {
      kind: 'table';
      title: string;
      data: { provider: string; query?: Record<string, unknown> };
      columns: { key: string; label: string; link?: { href: string; external?: boolean } }[];
    }
  | {
      kind: 'distribution';
      title: string;
      data: { provider: string; query?: Record<string, unknown> };
      markers?: Array<'p50' | 'p95' | 'p99'>;
      format?: 'duration' | 'number';
    }
  | {
      kind: 'gauge';
      title: string;
      data: { provider: string; query?: Record<string, unknown> };
      min?: number;
      max?: number;
      format?: 'number' | 'percent' | 'duration' | 'rate';
      thresholds?: PanelThresholds;
    }
  | {
      kind: 'breakdown';
      title: string;
      data: { provider: string; query?: Record<string, unknown> };
      style?: 'donut' | 'bar';
    };

export interface TelescopeMeta {
  enabled: boolean;
  droppedCount: number;
  watchers: string[];
  traceLink: string | null;
  /**
   * Whether the host wired a `traceContext` provider. Absent on older servers
   * that predate the field — treated as "show the Traces nav" so the UI stays
   * backward-compatible. Only a positive `false` hides the (otherwise empty)
   * Traces page.
   */
  tracesEnabled?: boolean;
  /** Resolved retention window from `prune`, or `null` when unbounded. */
  retention: { afterMs: number; keepLast: number | null } | null;
  /** Whether on-demand pruning is available (prune window AND mutations enabled). */
  pruneEnabled: boolean;
  /** Whether query EXPLAIN is available (host configured an `explainQuery` hook). */
  explainEnabled: boolean;
  /** Resolved per-type sample rates (0..1). Empty when no sampling configured. */
  sampling: Record<string, number>;
  /**
   * Dashboard auth state for the AUTHENTICATED SPA (e.g. show the logout button
   * when enabled). The unauthenticated SPA learns the modes from `/auth/me`.
   */
  auth: { enabled: boolean; modes: AuthMode[] };
  /**
   * AI exception-diagnosis state. `enabled` is true when the host configured a
   * `diagnoser`; the dashboard renders the "Diagnose with AI" button on exception
   * detail pages only then. `mode` is informational. OPTIONAL so the UI stays
   * backward-compatible with older servers that predate the field (treated as
   * disabled).
   */
  ai?: { enabled: boolean; mode: 'auto' | 'on-demand' | null };
  /**
   * Entry types contributed by extensions, merged with the built-in types by the
   * core. Each carries a stable `id` (the backend `type` filter), a `label`, and
   * a Tailwind `bg-*` dot color. OPTIONAL for backward-compat with older servers
   * that predate extension support.
   */
  entryTypes?: { id: string; label: string; dot: string }[];
  /**
   * Custom dashboards contributed by extensions. Each has a stable `id`, a nav
   * `label`, an optional `navGroup` for grouping in the sidebar, and a list of
   * {@link Panel}s rendered by the dashboard page (Task 9) / panel renderer
   * (Task 8). OPTIONAL for backward-compat with older servers.
   */
  dashboards?: {
    id: string;
    label: string;
    navGroup?: string;
    panels: Panel[];
    sections?: { title?: string; cols?: 2 | 3 | 4; panels: Panel[] }[];
  }[];
  /**
   * CPU flamegraph profiling state. `enabled` gates the Profiles nav item;
   * `sampleRate` is shown as a read-only badge. OPTIONAL for backward-compat with
   * older servers that predate profiling (treated as disabled → nav hidden).
   */
  profiling?: { enabled: boolean; sampleRate: number };
}

/** A node in the aggregated flamegraph tree (mirrors core's `FlameNode`). */
export interface FlameNode {
  name: string;
  file: string;
  totalMs: number;
  selfMs: number;
  totalSamples: number;
  children: FlameNode[];
}

/** A hottest-by-self frame (mirrors core's `HotFrame`). */
export interface HotFrame {
  name: string;
  file: string;
  selfMs: number;
  selfPct: number;
}

/** The content of a `cpu_profile` entry (mirrors core's `CpuProfileContent`). */
export interface CpuProfileContent {
  durationMs: number;
  sampleCount: number;
  reason: 'manual' | 'sampled';
  label: string | null;
  tree: FlameNode;
  hot: HotFrame[];
}

/** Profiler runtime status from `GET /profiles/status`. */
export interface ProfilerStatus {
  enabled: boolean;
  sampleRate: number;
  active: number;
  maxConcurrent: number;
  pendingManual: number;
}

/**
 * Outcome of `POST /exceptions/:id/diagnose`: the markdown report and whether it
 * was served from cache, or a clean error message (404 AI-off/bad-entry, 502
 * diagnoser failure) — surfaced rather than thrown, like {@link ExplainResult}.
 */
export type DiagnoseResult =
  | { ok: true; markdown: string; cached: boolean }
  | { ok: false; message: string };

/**
 * Outcome of the read-only `GET /exceptions/:id/diagnosis`: the ALREADY-cached
 * diagnosis for the entry's family, fetched on detail-page open so an auto-mode
 * (or previously on-demand) result shows immediately. The GET NEVER triggers a
 * diagnosis — so `null` simply means "nothing cached yet" (the server returns
 * 204), not a failure. A 404 (AI off / bad entry) also maps to `null`; the UI
 * already gates this fetch behind `meta.ai.enabled`, so a 404 just means nothing
 * to show.
 */
export type CachedDiagnosis = { markdown: string; cached: true } | null;
/**
 * Retention/prune status returned by `GET /retention`. `entryCount` and
 * `oldestCreatedAt` are `null` unless the storage SPI can expose them cheaply
 * (it currently can't, so Telescope never scans to derive them).
 */
export interface RetentionInfo {
  retention: { afterMs: number; keepLast: number | null } | null;
  entryCount: number | null;
  oldestCreatedAt: string | null;
  pruneSupported: true;
}

/** Outcome of `POST /queries/explain`: the plan, or a clean error message. */
export type ExplainResult = { ok: true; plan: unknown } | { ok: false; message: string };

/** What kicked off a prune cycle. Mirrors core's `PruneTrigger`. */
export type PruneTrigger = 'scheduled' | 'manual';

/**
 * One recorded prune cycle from `GET /prunes`. Mirrors core's `PruneRun`. The
 * ring is PER-POD (each replica records its own cycles), like server-stats
 * history. `deletedByType` carries real per-type counts only for the
 * individually-handled scopes (per-type overrides / archived types); the global
 * bulk delete is folded into `deletedTotal`.
 */
export interface PruneRun {
  at: string;
  trigger: PruneTrigger;
  durationMs: number;
  deletedTotal: number;
  deletedByType: Record<string, number>;
  archivedTotal?: number;
  error?: string;
}

/** Resolved retention config surfaced to the Prunes screen. Mirrors core's `PrunesConfig`. */
export interface PrunesConfig {
  afterMs: number;
  intervalMs: number;
  keepLast: number | null;
  perType?: Record<string, number>;
}

/** Prune-run activity returned by `GET /prunes`. Mirrors core's `PrunesInfo`. */
export interface PrunesInfo {
  runs: PruneRun[];
  config: PrunesConfig | null;
  nextRunAt: string | null;
}

export interface DurationStats {
  avg: number;
  p50: number;
  p95: number;
  max: number;
}

export interface SlowEntry {
  id: string;
  type: string;
  durationMs: number;
  label: string;
  batchId: string;
}
export interface ExceptionGroup {
  familyHash: string;
  class: string;
  message: string;
  count: number;
  lastSeen: string;
}
export interface NPlusOneHotspot {
  familyHash: string;
  sql: string;
  perRequest: number;
  requests: number;
  total: number;
  /** Total ms spent across all occurrences of this loop family — the cost weight. */
  totalDurationMs: number;
  sampleBatchId: string;
}
export interface SlowRouteHotspot {
  /** The normalized route family (e.g. "GET /api/base/:id/mel") — also the label. */
  route: string;
  count: number;
  p99: number;
  p50: number;
}

export interface PulseReport {
  windowStart: string;
  windowEnd: string;
  windowMs: number;
  counts: Record<string, number>;
  slowest: SlowEntry[];
  topExceptions: ExceptionGroup[];
  nPlusOne: NPlusOneHotspot[];
  slowRoutes: SlowRouteHotspot[];
  /** Slowest outgoing http_client targets (method + host + normalized path). */
  slowOutgoing: SlowRouteHotspot[];
  /** Slowest job families by p99 (optional — older servers omit it). */
  slowJobs?: SlowRouteHotspot[];
  /** Top users by total request time (optional — older servers omit it). */
  loadByUser?: UserLoad[];
  scanned: number;
  truncated: boolean;
}

/** A user's share of load in the window — mirrors core's `UserLoad`. */
export interface UserLoad {
  user: string;
  count: number;
  totalDurationMs: number;
}

/**
 * Telescope's own runtime overhead. Returned by `GET /health`. Lets a user see
 * that capture is cheap (off the response path) and the buffer keeps up.
 */
export interface TelescopeHealth {
  /** Whether capture is currently enabled (from config). */
  enabled: boolean;
  /** Total entries that passed sampling+filter and were buffered since boot. */
  recorded: number;
  /** Ring-buffer capacity. */
  bufferSize: number;
  /** Entries currently held in the ring. */
  bufferUsed: number;
  /** Maximum `bufferUsed` ever observed. */
  bufferHighWater: number;
  /** Number of flushes that drained at least one entry. */
  flushes: number;
  /** Cumulative entries drained across all flushes. */
  flushedEntries: number;
  /** Wall-clock duration of the most recent draining flush, or null. */
  lastFlushMs: number | null;
  /** Largest flush duration ever observed, or null. */
  maxFlushMs: number | null;
  /** Cumulative flush duration across all draining flushes. */
  totalFlushMs: number;
  /** Entries evicted because the ring was full. */
  overflowDropped: number;
  /** Entries lost because the store rejected the flush. */
  storeFailedDropped: number;
  /** Total entries dropped (overflow + store failures). */
  droppedCount: number;
  /** Entries whose content was clipped by a redaction bound (depth/string/array/node). */
  truncatedCount: number;
  /** Mean nanoseconds per capture, from an on-demand micro-benchmark. */
  captureCostNanos: number;
}

/** Point-in-time Node process-health snapshot. Returned by `GET /server-stats`. */
export interface ServerStats {
  uptimeSec: number;
  memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number };
  cpu: { userMs: number; systemMs: number };
  /** Mean event-loop delay in ms, or `null` when perf_hooks can't measure it. */
  eventLoopDelayMs: number | null;
  instanceId: string;
}

/** One point in the CPU/mem history. Mirrors core's `ServerStatsSample`. */
export interface ServerStatsSample {
  atMs: number;
  rssMb: number;
  heapUsedMb: number;
  cpuPercent: number;
  eventLoopDelayMs: number | null;
}

export interface ServerStatsHistory {
  samples: ServerStatsSample[];
}

export interface QueueMetrics {
  queue: string;
  total: number;
  completed: number;
  failed: number;
  failureRate: number;
  throughputPerMinute: number;
  runtimeMs: DurationStats | null;
  waitMs: DurationStats | null;
}
export interface QueueMetricsReport {
  windowStart: string;
  windowEnd: string;
  windowMs: number;
  queues: QueueMetrics[];
  scanned: number;
  truncated: boolean;
}

export interface TimeseriesBucket {
  t: string;
  total: number;
  byType: Record<string, number>;
}
export interface TimeseriesReport {
  windowStart: string;
  windowEnd: string;
  bucketMs: number;
  buckets: TimeseriesBucket[];
  scanned: number;
  truncated: boolean;
}
export interface TimeseriesQuery {
  window?: string;
  buckets?: number;
  type?: string;
  tag?: string;
}

export interface TraceSummary {
  traceId: string;
  entryCount: number;
  types: string[];
  /** ISO timestamp of the trace's earliest entry. */
  firstAt: string;
  /** ISO timestamp of the trace's latest entry. */
  lastAt: string;
  totalDurationMs: number;
  rootLabel?: string;
}
export interface TracesResult {
  traces: TraceSummary[];
  scanned: number;
  truncated: boolean;
}

/** One node of a trace waterfall. Mirrors core's `WaterfallSpan`. */
export interface WaterfallSpan {
  id: string;
  type: string;
  label: string;
  offsetMs: number;
  durationMs: number;
  depth: number;
  sequence: number;
  children: WaterfallSpan[];
}

/** A trace's nested span waterfall. Mirrors core's `Waterfall`. */
export interface Waterfall {
  traceStartMs: number;
  totalDurationMs: number;
  spans: WaterfallSpan[];
}

export interface LatencyStats {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  slow: number;
}
export interface FamilyLatency {
  familyHash: string;
  label: string;
  count: number;
  p50: number;
  p99: number;
}
export interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  hitRatio: number;
  topKeys: { key: string; count: number }[];
}
export interface StatusBreakdown {
  '2xx': number;
  '3xx': number;
  '4xx': number;
  '5xx': number;
  other: number;
}
/** An exception group in the stats payload — keyed by familyHash (or `class: message`),
 *  with occurrence count, last-seen, and a per-bucket over-time series. `lastAt`
 *  is JSON-serialized to an ISO string over the wire. */
export interface StatsExceptionGroup {
  key: string;
  class: string;
  message: string;
  count: number;
  lastAt: string;
  overTime: number[];
}
export interface StatsResult {
  type: string;
  windowMs: number;
  total: number;
  /** Throughput over the window — same shape the overview area chart consumes. */
  overTime: TimeseriesReport;
  latency?: LatencyStats;
  families?: FamilyLatency[];
  cache?: CacheStats;
  status?: StatusBreakdown;
  exceptions?: StatsExceptionGroup[];
  truncated: boolean;
}
