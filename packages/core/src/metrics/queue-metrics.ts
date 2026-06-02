// packages/core/src/metrics/queue-metrics.ts
import type { Entry } from '../entry/entry.js';

export interface DurationStats {
  avg: number;
  p50: number;
  p95: number;
  max: number;
}

export interface QueueMetrics {
  queue: string;
  total: number;
  completed: number;
  failed: number;
  /** failed / total, in [0, 1]. */
  failureRate: number;
  /** total jobs / window minutes. */
  throughputPerMinute: number;
  /** Processing-time stats (from `Entry.durationMs`); null when no samples. */
  runtimeMs: DurationStats | null;
  /** Queue-wait stats (from `JobContent.waitMs`); null when no samples. */
  waitMs: DurationStats | null;
}

export interface QueueMetricsReport {
  windowStart: string;
  windowEnd: string;
  windowMs: number;
  queues: QueueMetrics[];
}

interface JobView {
  queue: string;
  status: string | null;
  waitMs: number | null;
}

/** Defensively read the queue/status/waitMs we need off an entry's content. */
function readJob(content: unknown): JobView {
  if (typeof content !== 'object' || content === null) {
    return { queue: 'unknown', status: null, waitMs: null };
  }
  const record = content as Record<string, unknown>;
  const queue = typeof record.queue === 'string' && record.queue ? record.queue : 'unknown';
  return {
    queue,
    status: typeof record.status === 'string' ? record.status : null,
    waitMs: typeof record.waitMs === 'number' ? record.waitMs : null,
  };
}

/** Nearest-rank percentile of an ascending-sorted array. */
function percentile(sortedAscending: number[], fraction: number): number {
  if (sortedAscending.length === 0) return 0;
  const rank = Math.ceil(fraction * sortedAscending.length);
  const index = Math.min(sortedAscending.length, Math.max(1, rank)) - 1;
  return sortedAscending[index]!;
}

function statsOf(values: number[]): DurationStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    avg: sum / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1]!,
  };
}

interface QueueAccumulator {
  total: number;
  completed: number;
  failed: number;
  runtimes: number[];
  waits: number[];
}

/** Group `job` entries by queue and compute per-queue throughput, runtime/wait
 *  percentiles, and failure rate over the [windowStart, windowEnd] window.
 *  Non-job entries are ignored. Pure: callers fetch the entries; entries are
 *  assumed already windowed (createdAt is not re-checked here). */
export function aggregateQueueMetrics(
  entries: Entry[],
  windowStart: Date,
  windowEnd: Date,
): QueueMetricsReport {
  const windowMs = Math.max(0, windowEnd.getTime() - windowStart.getTime());
  const windowMinutes = windowMs / 60_000;

  const groups = new Map<string, QueueAccumulator>();
  for (const entry of entries) {
    if (entry.type !== 'job') continue;
    const job = readJob(entry.content);
    let group = groups.get(job.queue);
    if (!group) {
      group = { total: 0, completed: 0, failed: 0, runtimes: [], waits: [] };
      groups.set(job.queue, group);
    }
    group.total += 1;
    if (job.status === 'failed') group.failed += 1;
    else if (job.status === 'completed') group.completed += 1;
    // Runtime samples are status-agnostic: any job with a numeric durationMs.
    if (typeof entry.durationMs === 'number') group.runtimes.push(entry.durationMs);
    if (job.waitMs !== null) group.waits.push(job.waitMs);
  }

  const queues: QueueMetrics[] = [...groups.entries()]
    .map(([queue, group]) => ({
      queue,
      total: group.total,
      completed: group.completed,
      failed: group.failed,
      failureRate: group.total > 0 ? group.failed / group.total : 0,
      throughputPerMinute: windowMinutes > 0 ? group.total / windowMinutes : 0,
      runtimeMs: statsOf(group.runtimes),
      waitMs: statsOf(group.waits),
    }))
    .sort((a, b) => b.total - a.total || a.queue.localeCompare(b.queue));

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    windowMs,
    queues,
  };
}
