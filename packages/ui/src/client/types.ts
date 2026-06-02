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
  batchId?: string;
  familyHash?: string;
  cursor?: string;
  limit?: number;
}
export interface TelescopeMeta {
  enabled: boolean;
  droppedCount: number;
  watchers: string[];
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
export interface NPlusOneOccurrence {
  batchId: string;
  familyHash: string;
  count: number;
  sql: string;
}

export interface PulseReport {
  windowStart: string;
  windowEnd: string;
  windowMs: number;
  counts: Record<string, number>;
  slowest: SlowEntry[];
  topExceptions: ExceptionGroup[];
  nPlusOne: NPlusOneOccurrence[];
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
