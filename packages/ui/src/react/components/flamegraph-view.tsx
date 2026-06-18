// packages/ui/src/react/components/flamegraph-view.tsx
import { type JSX, useMemo, useState } from 'react';
import type { FlameNode } from '../../client/index.js';
import { flameColor, flameDepth, flattenFlame, formatProfileMs } from './flamegraph.js';

const ROW_HEIGHT = 18;

/**
 * A dependency-light flamegraph (icicle layout, root at top). Renders one
 * absolutely-positioned `<div>` per visible frame — no canvas, no charting
 * library — sized as a percentage of the container width so it's responsive and
 * SSR-safe. Clicking a frame "zooms" to make it the new 100%-width root; click
 * the root or the reset control to zoom back out.
 *
 * Why div-based: the frame trees are pre-aggregated and pruned server-side (and
 * again here via `minWidthFraction`), so the visible cell count is small enough
 * that the DOM is the simplest robust renderer. This keeps the UI bundle free of
 * a heavy flamegraph dependency, as the task requires.
 */
export function Flamegraph({ tree }: { tree: FlameNode }): JSX.Element {
  // Zoom focus: the path key of the frame currently treated as the root.
  const [focusKey, setFocusKey] = useState('0');

  const cells = useMemo(() => flattenFlame(tree), [tree]);
  const depth = flameDepth(cells);

  // Resolve the focused subtree's x/width so we can rescale all cells to it.
  const focus = cells.find((c) => c.key === focusKey) ?? cells[0];
  const focusX = focus?.x ?? 0;
  const focusWidth = focus?.width ?? 1;
  const focusDepth = focus?.depth ?? 0;

  if (tree.totalMs <= 0 || cells.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900/40 text-xs text-zinc-500">
        No samples — the capture was empty.
      </div>
    );
  }

  // Only render cells inside the focused subtree (its descendants), rescaled.
  const visible = cells.filter((c) => c.key === focusKey || c.key.startsWith(`${focusKey}.`));
  const rows = depth - focusDepth;

  return (
    <div>
      {focusKey !== '0' && (
        <button
          type="button"
          onClick={() => setFocusKey('0')}
          className="mb-2 rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-800"
        >
          ← Reset zoom
        </button>
      )}
      <div
        data-testid="flamegraph"
        className="relative w-full overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950"
        style={{ height: rows * ROW_HEIGHT + 2 }}
      >
        {visible.map((cell) => {
          const left = ((cell.x - focusX) / focusWidth) * 100;
          const width = (cell.width / focusWidth) * 100;
          const top = (cell.depth - focusDepth) * ROW_HEIGHT;
          const pct = ((cell.node.totalMs / tree.totalMs) * 100).toFixed(1);
          return (
            <button
              type="button"
              key={cell.key}
              onClick={() => setFocusKey(cell.key)}
              title={`${cell.node.name}${cell.node.file ? ` — ${cell.node.file}` : ''}\ntotal ${formatProfileMs(
                cell.node.totalMs,
              )} (${pct}%) · self ${formatProfileMs(cell.node.selfMs)}`}
              className="absolute flex items-center overflow-hidden border border-zinc-950/60 px-1 text-left text-[10px] leading-none text-black/80 hover:brightness-110"
              style={{
                left: `${left}%`,
                width: `${width}%`,
                top,
                height: ROW_HEIGHT - 1,
                background: cell.node.name === '(root)' ? '#3f3f46' : flameColor(cell.node.name),
              }}
            >
              <span
                className="truncate"
                style={cell.node.name === '(root)' ? { color: '#e4e4e7' } : {}}
              >
                {cell.node.name}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
