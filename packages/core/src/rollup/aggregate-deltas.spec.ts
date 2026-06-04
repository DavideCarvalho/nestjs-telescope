import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { aggregateDeltas } from './aggregate-deltas.js';
import {
  HISTOGRAM_BUCKET_COUNT,
  type RollupDelta,
  emptyHistogram,
  floorToBucket,
  histogramBucketIndex,
  incrementHistogram,
} from './rollup-store.js';

/** Builds the expected histogram from a list of durations (nulls skipped). */
function histogramOf(durations: (number | null)[]): number[] {
  const histogram = emptyHistogram();
  for (const duration of durations) {
    if (duration !== null) incrementHistogram(histogram, duration);
  }
  return histogram;
}

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
      {
        metric: 'query',
        bucketStart: minute0,
        count: 1,
        sum: 5,
        max: 5,
        histogram: histogramOf([5]),
      },
      {
        metric: 'request',
        bucketStart: minute0,
        count: 3,
        sum: 40,
        max: 30,
        // null duration does NOT increment the histogram (count/sum/max only).
        histogram: histogramOf([10, 30]),
      },
      {
        metric: 'request',
        bucketStart: minute1,
        count: 1,
        sum: 7,
        max: 7,
        histogram: histogramOf([7]),
      },
    ]);
  });

  it('yields max 0 and an all-zeros histogram when every duration in a group is null', () => {
    const minute0 = floorToBucket(1_700_000_000_000);
    const deltas = aggregateDeltas([
      entry('job', new Date(minute0 + 1_000), null),
      entry('job', new Date(minute0 + 2_000), null),
    ]);
    expect(deltas).toEqual([
      {
        metric: 'job',
        bucketStart: minute0,
        count: 2,
        sum: 0,
        max: 0,
        histogram: emptyHistogram(),
      },
    ]);
  });

  it('places durations in the right histogram cells incl. boundary edges and overflow', () => {
    const minute0 = floorToBucket(1_700_000_000_000);
    // Boundaries: [1,2,5,10,25,50,100,250,500,1000,2500,5000,10000].
    // 1 → cell 0 (<=1); 2 → cell 1 (<=2, boundary edge); 3 → cell 2 (<=5);
    // 10000 → cell 12 (<=10000, last boundary edge); 10001 → cell 13 (overflow).
    const deltas = aggregateDeltas([
      entry('request', new Date(minute0 + 1_000), 1),
      entry('request', new Date(minute0 + 2_000), 2),
      entry('request', new Date(minute0 + 3_000), 3),
      entry('request', new Date(minute0 + 4_000), 10000),
      entry('request', new Date(minute0 + 5_000), 10001),
    ]);
    const histogram = deltas[0]?.histogram ?? [];
    expect(histogram).toHaveLength(HISTOGRAM_BUCKET_COUNT);
    expect(histogram[0]).toBe(1); // value 1
    expect(histogram[1]).toBe(1); // value 2 (boundary edge of cell 1)
    expect(histogram[2]).toBe(1); // value 3
    expect(histogram[12]).toBe(1); // value 10000 (last boundary edge)
    expect(histogram[13]).toBe(1); // value 10001 (overflow)
    expect(histogramBucketIndex(0)).toBe(0); // zero lands in cell 0
  });
});
