import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TimeseriesBucket } from '../../client/index.js';
import { StackedBars, deriveTypes, stackedBarLayout } from './stacked-bars.js';

const buckets: TimeseriesBucket[] = [
  { t: '', total: 3, byType: { request: 2, query: 1 } },
  { t: '', total: 0, byType: {} },
  { t: '', total: 2, byType: { query: 2 } },
];

describe('deriveTypes', () => {
  it('returns known types first, present-only', () => {
    expect(deriveTypes(buckets)).toEqual(['request', 'query']);
  });
});

describe('stackedBarLayout', () => {
  it('stacks segments bottom-up scaled to the max bucket total', () => {
    // maxTotal = 3, height 30 => unit 10px/count. Bucket 0: query(1)=10 on top, request(2)=20 below.
    const segments = stackedBarLayout(buckets, ['request', 'query'], 30, 30);
    // bucket 0 has 2 segments; empty bucket 1 has none; bucket 2 has 1
    expect(segments.filter((s) => s.x === 0)).toHaveLength(2);
    expect(segments.filter((s) => s.x === 10)).toHaveLength(0); // empty bucket
    const req = segments.find((s) => s.x === 0 && s.type === 'request')!;
    expect(req.height).toBeCloseTo(20);
    expect(req.y).toBeCloseTo(10); // sits below the query segment
  });
  it('returns [] for no buckets', () => {
    expect(stackedBarLayout([], ['request'], 10, 10)).toEqual([]);
  });
});

describe('StackedBars', () => {
  it('renders an svg with rects', () => {
    const { container } = render(<StackedBars buckets={buckets} />);
    expect(container.querySelector('svg')).toBeTruthy();
    expect(container.querySelectorAll('rect').length).toBeGreaterThan(0);
  });
});
