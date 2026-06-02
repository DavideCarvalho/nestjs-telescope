// packages/core/src/metrics/queue-metrics.spec.ts
import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { aggregateQueueMetrics } from './queue-metrics.js';

function jobEntry(
  queue: string,
  status: 'completed' | 'failed',
  durationMs: number | null,
  waitMs: number | null,
): Entry {
  return {
    id: `${queue}-${Math.random()}`,
    batchId: 'b',
    type: 'job',
    familyHash: `${queue}:x`,
    content: { queue, status, waitMs },
    tags: [],
    sequence: 0,
    durationMs,
    origin: 'queue',
    instanceId: 'i',
    createdAt: new Date('2026-06-02T12:00:00Z'),
  };
}

const start = new Date('2026-06-02T11:00:00Z'); // 60-minute window
const end = new Date('2026-06-02T12:00:00Z');

describe('aggregateQueueMetrics', () => {
  it('groups by queue with counts, failure rate, and throughput', () => {
    const entries = [
      jobEntry('mail', 'completed', 100, 10),
      jobEntry('mail', 'completed', 300, 30),
      jobEntry('mail', 'failed', 200, 20),
      jobEntry('reports', 'completed', 1000, 0),
    ];
    const report = aggregateQueueMetrics(entries, start, end);

    expect(report.windowMs).toBe(3_600_000);
    expect(report.windowStart).toBe('2026-06-02T11:00:00.000Z');
    expect(report.queues.map((q) => q.queue)).toEqual(['mail', 'reports']);

    const mail = report.queues[0]!;
    expect(mail.total).toBe(3);
    expect(mail.completed).toBe(2);
    expect(mail.failed).toBe(1);
    expect(mail.failureRate).toBeCloseTo(1 / 3);
    expect(mail.throughputPerMinute).toBeCloseTo(3 / 60);
    expect(mail.runtimeMs).not.toBeNull();
    expect(mail.runtimeMs!.max).toBe(300);
    expect(mail.runtimeMs!.avg).toBe(200);
    expect(mail.waitMs!.max).toBe(30);
  });

  it('ignores non-job entries', () => {
    const request: Entry = { ...jobEntry('mail', 'completed', 100, 10), type: 'request' };
    const report = aggregateQueueMetrics(
      [request, jobEntry('mail', 'completed', 50, 5)],
      start,
      end,
    );
    expect(report.queues).toHaveLength(1);
    expect(report.queues[0]!.total).toBe(1);
  });

  it('reports null runtime/wait stats when no samples are present', () => {
    const report = aggregateQueueMetrics([jobEntry('mail', 'completed', null, null)], start, end);
    expect(report.queues[0]!.runtimeMs).toBeNull();
    expect(report.queues[0]!.waitMs).toBeNull();
  });

  it('buckets entries with a missing/empty queue under "unknown"', () => {
    const noQueue: Entry = {
      ...jobEntry('', 'completed', 100, 10),
      content: { status: 'completed' },
    };
    const report = aggregateQueueMetrics([noQueue], start, end);
    expect(report.queues[0]!.queue).toBe('unknown');
  });

  it('computes nearest-rank percentiles', () => {
    const entries = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((d) =>
      jobEntry('mail', 'completed', d, null),
    );
    const stats = aggregateQueueMetrics(entries, start, end).queues[0]!.runtimeMs!;
    expect(stats.p50).toBe(50);
    expect(stats.p95).toBe(100);
    expect(stats.max).toBe(100);
  });

  it('returns an empty queues list for no entries', () => {
    const report = aggregateQueueMetrics([], start, end);
    expect(report.queues).toEqual([]);
  });
});
