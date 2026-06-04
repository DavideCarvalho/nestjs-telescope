import { describe, expect, it } from 'vitest';
import { estimatePercentileFromHistogram } from './estimate-percentile.js';
import { LATENCY_BOUNDARIES_MS, emptyHistogram, incrementHistogram } from './rollup-store.js';

/** Exact nearest-rank percentile over raw values (mirrors stats.ts `percentile`). */
function exactPercentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? 0;
}

/** The widest gap between adjacent boundaries up to and including value `v`'s
 *  bucket — the worst-case tolerance for a bucket-resolution estimate of `v`. */
function bucketWidthAround(value: number): number {
  let previous = 0;
  for (const boundary of LATENCY_BOUNDARIES_MS) {
    if (value <= boundary) return boundary - previous;
    previous = boundary;
  }
  // Overflow: tolerance is the last boundary gap.
  const last = LATENCY_BOUNDARIES_MS[LATENCY_BOUNDARIES_MS.length - 1] ?? 0;
  const secondLast = LATENCY_BOUNDARIES_MS[LATENCY_BOUNDARIES_MS.length - 2] ?? 0;
  return last - secondLast;
}

function histogramOf(values: number[]): number[] {
  const histogram = emptyHistogram();
  for (const value of values) incrementHistogram(histogram, value);
  return histogram;
}

describe('estimatePercentileFromHistogram', () => {
  it('returns 0 for an all-zeros / empty histogram', () => {
    expect(estimatePercentileFromHistogram(emptyHistogram(), 0.5)).toBe(0);
    expect(estimatePercentileFromHistogram(emptyHistogram(), 0.99)).toBe(0);
  });

  it('returns 0 and never NaN for a legacy/short array', () => {
    expect(estimatePercentileFromHistogram([], 0.5)).toBe(0);
    expect(Number.isNaN(estimatePercentileFromHistogram([1, 2], 0.95))).toBe(false);
  });

  it('returns the bucket upper boundary for the rank-containing cell', () => {
    // 10 samples all at 7ms → cell for <=10 → estimate 10 (the bucket upper edge).
    const histogram = histogramOf(new Array<number>(10).fill(7));
    expect(estimatePercentileFromHistogram(histogram, 0.5)).toBe(10);
    expect(estimatePercentileFromHistogram(histogram, 0.99)).toBe(10);
  });

  it('caps the overflow bucket to the last finite boundary (never Infinity)', () => {
    const histogram = histogramOf([50_000, 99_999]); // both overflow (> 10000)
    const last = LATENCY_BOUNDARIES_MS[LATENCY_BOUNDARIES_MS.length - 1] ?? 0;
    const estimate = estimatePercentileFromHistogram(histogram, 0.99);
    expect(Number.isFinite(estimate)).toBe(true);
    expect(estimate).toBe(last);
  });

  it('estimates p50/p95/p99 within one bucket-width of the exact nearest-rank', () => {
    // A spread distribution across many buckets.
    const values: number[] = [];
    for (let i = 0; i < 1000; i += 1) values.push(((i * 37) % 9000) + 1); // 1..9000
    const histogram = histogramOf(values);

    for (const fraction of [0.5, 0.95, 0.99]) {
      const exact = exactPercentile(values, fraction);
      const estimate = estimatePercentileFromHistogram(histogram, fraction);
      expect(Math.abs(estimate - exact)).toBeLessThanOrEqual(bucketWidthAround(exact));
    }
  });

  it('uses strictly increasing boundaries (monotonic buckets)', () => {
    for (let i = 1; i < LATENCY_BOUNDARIES_MS.length; i += 1) {
      expect((LATENCY_BOUNDARIES_MS[i] ?? 0) > (LATENCY_BOUNDARIES_MS[i - 1] ?? 0)).toBe(true);
    }
  });
});
