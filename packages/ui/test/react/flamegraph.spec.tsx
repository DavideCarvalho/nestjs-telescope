import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { FlameNode } from '../../src/client/types.js';
import { Flamegraph } from '../../src/react/components/flamegraph-view.js';
import { flameDepth, flattenFlame } from '../../src/react/components/flamegraph.js';

const TREE: FlameNode = {
  name: '(root)',
  file: '',
  selfMs: 0,
  totalMs: 100,
  totalSamples: 100,
  children: [
    {
      name: 'handler',
      file: 'app.js:10',
      selfMs: 20,
      totalMs: 80,
      totalSamples: 80,
      children: [
        { name: 'query', file: 'db.js:5', selfMs: 60, totalMs: 60, totalSamples: 60, children: [] },
      ],
    },
    { name: 'render', file: 'view.js:2', selfMs: 20, totalMs: 20, totalSamples: 20, children: [] },
  ],
};

describe('flattenFlame', () => {
  it('positions the root full width at depth 0', () => {
    const cells = flattenFlame(TREE);
    const root = cells.find((c) => c.node.name === '(root)');
    expect(root?.x).toBe(0);
    expect(root?.width).toBe(1);
    expect(root?.depth).toBe(0);
  });

  it('sizes children proportional to total time and lays out widest-first', () => {
    const cells = flattenFlame(TREE);
    const handler = cells.find((c) => c.node.name === 'handler');
    const render = cells.find((c) => c.node.name === 'render');
    expect(handler?.width).toBeCloseTo(0.8, 5);
    expect(render?.width).toBeCloseTo(0.2, 5);
    // widest-first: handler (0.8) starts at x=0, render after it at x=0.8
    expect(handler?.x).toBeCloseTo(0, 5);
    expect(render?.x).toBeCloseTo(0.8, 5);
  });

  it('nests grandchildren at the right depth', () => {
    const cells = flattenFlame(TREE);
    const query = cells.find((c) => c.node.name === 'query');
    expect(query?.depth).toBe(2);
    expect(query?.width).toBeCloseTo(0.6, 5);
    expect(flameDepth(cells)).toBe(3);
  });

  it('prunes cells narrower than the minimum width fraction', () => {
    const wide: FlameNode = {
      name: '(root)',
      file: '',
      selfMs: 0,
      totalMs: 1000,
      totalSamples: 1000,
      children: [
        { name: 'big', file: '', selfMs: 999, totalMs: 999, totalSamples: 999, children: [] },
        { name: 'tiny', file: '', selfMs: 1, totalMs: 1, totalSamples: 1, children: [] },
      ],
    };
    const cells = flattenFlame(wide, 0.01); // 1% min
    expect(cells.some((c) => c.node.name === 'big')).toBe(true);
    expect(cells.some((c) => c.node.name === 'tiny')).toBe(false);
  });
});

describe('Flamegraph component', () => {
  it('renders a bar per visible frame with its name', () => {
    render(<Flamegraph tree={TREE} />);
    expect(screen.getByText('(root)')).toBeTruthy();
    expect(screen.getByText('handler')).toBeTruthy();
    expect(screen.getByText('query')).toBeTruthy();
    expect(screen.getByText('render')).toBeTruthy();
  });

  it('shows an empty state for a zero-time tree', () => {
    const empty: FlameNode = {
      name: '(root)',
      file: '',
      selfMs: 0,
      totalMs: 0,
      totalSamples: 0,
      children: [],
    };
    render(<Flamegraph tree={empty} />);
    expect(screen.getByText(/no samples/i)).toBeTruthy();
  });
});
