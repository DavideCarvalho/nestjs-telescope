export type {
  JobPage,
  QueueActionName,
  QueueCounts,
  QueueJob,
  QueueJobDetail,
  QueueState,
  QueueSummary,
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
  cursor?: string;
  limit?: number;
}
export interface TelescopeMeta {
  enabled: boolean;
  droppedCount: number;
  watchers: string[];
  traceLink: string | null;
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
  scanned: number;
  truncated: boolean;
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
  truncated: boolean;
}
