import { describe, expect, it } from 'vitest';
import { aggregateCpuProfile } from './aggregate-profile.js';
import type { V8CpuProfile } from './types.js';

/**
 * Builds a minimal V8 profile. `samples` references node ids; `timeDeltas` are
 * microseconds elapsed BEFORE each sample (the V8 convention). Each frame is
 * 1ms apart by default.
 */
function profile(
  nodes: V8CpuProfile['nodes'],
  samples: number[],
  timeDeltas?: number[],
): V8CpuProfile {
  const deltas = timeDeltas ?? samples.map(() => 1000);
  const total = deltas.reduce((a, b) => a + b, 0);
  return { nodes, samples, timeDeltas: deltas, startTime: 0, endTime: total };
}

function frame(
  id: number,
  functionName: string,
  children: number[] = [],
  url = 'file.js',
  lineNumber = 0,
): V8CpuProfile['nodes'][number] {
  return {
    id,
    callFrame: { functionName, scriptId: '1', url, lineNumber, columnNumber: 0 },
    children,
  };
}

describe('aggregateCpuProfile', () => {
  it('rolls per-sample time up to a single synthetic root', () => {
    // root(1) -> a(2) -> b(3). Samples land on b twice, a once.
    const p = profile(
      [frame(1, '(root)', [2]), frame(2, 'a', [3]), frame(3, 'b')],
      [3, 3, 2],
      [1000, 1000, 1000],
    );
    const { tree, durationMs, sampleCount } = aggregateCpuProfile(p);
    expect(tree.name).toBe('(root)');
    expect(durationMs).toBe(3);
    expect(sampleCount).toBe(3);
    // root total = whole capture; root self = 0 (never sampled directly here).
    expect(tree.totalMs).toBeCloseTo(3, 5);
    expect(tree.selfMs).toBe(0);
  });

  it('computes self vs total per frame from sample attribution', () => {
    // a sampled once (self), b sampled twice (self). a.total = a.self + b.total.
    const p = profile([frame(1, '(root)', [2]), frame(2, 'a', [3]), frame(3, 'b')], [2, 3, 3]);
    const { tree } = aggregateCpuProfile(p);
    const a = tree.children.find((c) => c.name === 'a');
    expect(a).toBeDefined();
    expect(a?.selfMs).toBeCloseTo(1, 5); // one sample on a
    expect(a?.totalMs).toBeCloseTo(3, 5); // a + its child b (2 samples)
    const b = a?.children.find((c) => c.name === 'b');
    expect(b?.selfMs).toBeCloseTo(2, 5);
    expect(b?.totalMs).toBeCloseTo(2, 5);
  });

  it('honors per-sample timeDeltas instead of assuming uniform spacing', () => {
    const p = profile([frame(1, '(root)', [2]), frame(2, 'slow')], [2, 2], [1000, 9000]);
    const { tree, durationMs } = aggregateCpuProfile(p);
    expect(durationMs).toBe(10);
    const slow = tree.children.find((c) => c.name === 'slow');
    expect(slow?.selfMs).toBeCloseTo(10, 5);
  });

  it('ranks hot frames by self time as percentages', () => {
    const p = profile(
      [frame(1, '(root)', [2, 3]), frame(2, 'hot'), frame(3, 'cold')],
      [2, 2, 2, 3],
    );
    const { hot } = aggregateCpuProfile(p);
    expect(hot[0]?.name).toBe('hot');
    expect(hot[0]?.selfPct).toBeCloseTo(75, 1);
    expect(hot[1]?.name).toBe('cold');
    expect(hot[1]?.selfPct).toBeCloseTo(25, 1);
  });

  it('normalizes empty/anonymous function names', () => {
    const p = profile([frame(1, '(root)', [2]), frame(2, '')], [2]);
    const { tree } = aggregateCpuProfile(p);
    expect(tree.children[0]?.name).toBe('(anonymous)');
  });

  it('returns a degenerate root for an empty profile without throwing', () => {
    const p = profile([frame(1, '(root)')], []);
    const { tree, sampleCount, durationMs } = aggregateCpuProfile(p);
    expect(sampleCount).toBe(0);
    expect(durationMs).toBe(0);
    expect(tree.totalMs).toBe(0);
  });

  it('handles a profile with no explicit (root) node by synthesizing one', () => {
    const p = profile([frame(2, 'a')], [2]);
    const { tree } = aggregateCpuProfile(p);
    expect(tree.name).toBe('(root)');
    expect(tree.children[0]?.name).toBe('a');
  });
});
