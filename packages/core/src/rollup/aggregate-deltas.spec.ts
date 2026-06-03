import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { aggregateDeltas } from './aggregate-deltas.js';
import { type RollupDelta, floorToBucket } from './rollup-store.js';

function entry(type: string, createdAt: Date, durationMs: number | null): Entry {
  return {
    id: `${type}-${createdAt.getTime()}-${Math.random()}`,
    batchId: 'b',
    type,
    familyHash: null,
    content: {},
    tags: [],
    sequence: 0,
    durationMs,
    origin: 'http',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt,
  };
}

function sortDeltas(deltas: RollupDelta[]): RollupDelta[] {
  return [...deltas].sort(
    (a, b) => a.metric.localeCompare(b.metric) || a.bucketStart - b.bucketStart,
  );
}

describe('aggregateDeltas', () => {
  it('returns no deltas for an empty batch', () => {
    expect(aggregateDeltas([])).toEqual([]);
  });

  it('groups by (type, 1-min bucket) with count/sum/max (null durations as 0)', () => {
    const b0 = 1_700_000_000_000; // arbitrary minute boundary
    const minute0 = floorToBucket(b0);
    const minute1 = minute0 + 60_000;

    const deltas = sortDeltas(
      aggregateDeltas([
        entry('request', new Date(minute0 + 1_000), 10),
        entry('request', new Date(minute0 + 30_000), 30),
        entry('request', new Date(minute0 + 59_000), null), // null → 0
        entry('query', new Date(minute0 + 5_000), 5),
        entry('request', new Date(minute1 + 2_000), 7), // next minute
      ]),
    );

    expect(deltas).toEqual([
      { metric: 'query', bucketStart: minute0, count: 1, sum: 5, max: 5 },
      { metric: 'request', bucketStart: minute0, count: 3, sum: 40, max: 30 },
      { metric: 'request', bucketStart: minute1, count: 1, sum: 7, max: 7 },
    ]);
  });

  it('yields max 0 when every duration in a group is null', () => {
    const minute0 = floorToBucket(1_700_000_000_000);
    const deltas = aggregateDeltas([
      entry('job', new Date(minute0 + 1_000), null),
      entry('job', new Date(minute0 + 2_000), null),
    ]);
    expect(deltas).toEqual([{ metric: 'job', bucketStart: minute0, count: 2, sum: 0, max: 0 }]);
  });
});
