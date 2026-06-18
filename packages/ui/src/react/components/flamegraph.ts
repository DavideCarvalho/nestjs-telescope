// packages/ui/src/react/components/flamegraph.ts
import type { FlameNode } from '../../client/index.js';

/**
 * A flame cell positioned for rendering: a horizontal bar at depth `depth`,
 * starting at `x` (fraction 0–1 of the root width) and spanning `width`
 * (fraction). Produced by {@link flattenFlame}, which is a PURE function so the
 * layout is unit-testable without a DOM.
 */
export interface FlameCell {
  /** Stable key path (indices from the root), e.g. "0.1.0". */
  key: string;
  node: FlameNode;
  depth: number;
  /** Left edge as a fraction (0–1) of the root's total width. */
  x: number;
  /** Width as a fraction (0–1) of the root's total width. */
  width: number;
}

/**
 * Flattens a flame tree into positioned cells using the icicle layout (root at
 * top, children below, each child's width proportional to its `totalMs` share of
 * the parent). Children are laid out left-to-right widest-first so the hot path
 * reads down the left edge — the convention Chrome DevTools / speedscope use.
 *
 * `minWidthFraction` prunes cells narrower than the given fraction of the root,
 * so a 50k-node profile doesn't emit tens of thousands of sub-pixel divs.
 */
export function flattenFlame(root: FlameNode, minWidthFraction = 0.002): FlameCell[] {
  const totalMs = root.totalMs > 0 ? root.totalMs : 1;
  const cells: FlameCell[] = [];

  const walk = (node: FlameNode, depth: number, x: number, width: number, key: string): void => {
    if (width < minWidthFraction) return;
    cells.push({ key, node, depth, x, width });
    const children = [...node.children].sort((a, b) => b.totalMs - a.totalMs);
    let childX = x;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child === undefined) continue;
      const childWidth = (child.totalMs / totalMs) * 1;
      walk(child, depth + 1, childX, childWidth, `${key}.${i}`);
      childX += childWidth;
    }
  };

  walk(root, 0, 0, 1, '0');
  return cells;
}

/** Max depth (number of rows) in a flattened cell list. */
export function flameDepth(cells: FlameCell[]): number {
  return cells.reduce((max, c) => Math.max(max, c.depth), 0) + 1;
}

/** A stable color for a frame, hashed from its name so siblings differ but a
 *  frame keeps its hue across renders. Warm palette (flamegraph convention). */
export function flameColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  // Hue in the warm band (0–45deg: red→orange→yellow), varied saturation.
  const hue = Math.abs(hash) % 46;
  const sat = 55 + (Math.abs(hash >> 8) % 25);
  const light = 45 + (Math.abs(hash >> 16) % 12);
  return `hsl(${hue}, ${sat}%, ${light}%)`;
}

export function formatProfileMs(ms: number): string {
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
