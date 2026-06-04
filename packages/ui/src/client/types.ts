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

export interface TelescopeMeta {
  enabled: boolean;
  droppedCount: number;
  watchers: string[];
  traceLink: string | null;
  /** Resolved retention window from `prune`, or `null` when unbounded. */
  retention: { afterMs: number; keepLast: number | null } | null;
  /** Resolved per-type sample rates (0..1). Empty when no sampling configured. */
  sampling: Record<string, number>;
  /**
   * Dashboard auth state for the AUTHENTICATED SPA (e.g. show the logout button
   * when enabled). The unauthenticated SPA learns the modes from `/auth/me`.
   */
  auth: { enabled: boolean; modes: AuthMode[] };
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
  scanned: number;
  truncated: boolean;
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
