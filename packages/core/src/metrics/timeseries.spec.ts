import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { bucketTimeseries } from './timeseries.js';

function entry(type: string, createdAt: Date): Entry {
  return {
    id: `${type}-${Math.random()}`,
    batchId: 'b',
    type,
    familyHash: null,
    content: {},
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'i',
    createdAt,
  };
}

const start = new Date('2026-06-02T11:00:00Z');
const end = new Date('2026-06-02T12:00:00Z'); // 60-minute window

describe('bucketTimeseries', () => {
  it('buckets entries into N equal time buckets with total + byType', () => {
    const report = bucketTimeseries(
      [
        entry('request', new Date('2026-06-02T11:00:30Z')),
        entry('query', new Date('2026-06-02T11:00:45Z')),
        entry('request', new Date('2026-06-02T11:30:00Z')),
        entry('job', new Date('2026-06-02T11:59:59Z')),
      ],
      start,
      end,
      60,
    );
    expect(report.buckets).toHaveLength(60);
    expect(report.bucketMs).toBe(60_000);
    expect(report.buckets[0]).toMatchObject({ total: 2, byType: { request: 1, query: 1 } });
    expect(report.buckets[30]).toMatchObject({ total: 1, byType: { request: 1 } });
    expect(report.buckets[59]).toMatchObject({ total: 1, byType: { job: 1 } });
    expect(report.buckets[1]!.total).toBe(0);
    expect(report.buckets[0]!.t).toBe('2026-06-02T11:00:00.000Z');
  });

  it('clamps an entry at windowEnd into the last bucket', () => {
    const report = bucketTimeseries([entry('request', end)], start, end, 10);
    expect(report.buckets[9]!.total).toBe(1);
  });

  it('handles empty input and a zero-length window without dividing by zero', () => {
    expect(bucketTimeseries([], start, end, 10).buckets).toHaveLength(10);
    const zero = bucketTimeseries([], start, start, 10);
    expect(zero.buckets).toHaveLength(10);
    expect(zero.bucketMs).toBeGreaterThanOrEqual(1);
  });
});
