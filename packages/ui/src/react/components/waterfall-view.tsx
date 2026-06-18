import type { Waterfall, WaterfallSpan } from '../../client/index.js';

/** Per-entry-type bar colour, mirroring the dashboard's entry-type palette. */
const TYPE_COLOR: Record<string, string> = {
  request: 'bg-sky-500',
  query: 'bg-amber-500',
  http_client: 'bg-violet-500',
  job: 'bg-emerald-500',
  cache: 'bg-teal-500',
  exception: 'bg-rose-500',
  event: 'bg-indigo-500',
  log: 'bg-zinc-500',
  mail: 'bg-pink-500',
  redis: 'bg-red-500',
};

function colorFor(type: string): string {
  return TYPE_COLOR[type] ?? 'bg-zinc-600';
}

function formatMs(ms: number): string {
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

interface RowProps {
  span: WaterfallSpan;
  totalDurationMs: number;
  onSelect?: ((id: string) => void) | undefined;
}

/** A flattened list of spans in depth-first order, preserving nesting via depth. */
function flatten(spans: WaterfallSpan[]): WaterfallSpan[] {
  const out: WaterfallSpan[] = [];
  const walk = (list: WaterfallSpan[]): void => {
    for (const span of list) {
      out.push(span);
      if (span.children.length > 0) walk(span.children);
    }
  };
  walk(spans);
  return out;
}

function WaterfallRow({ span, totalDurationMs, onSelect }: RowProps): JSX.Element {
  // Guard against a zero-width trace (all instant spans) so bars stay visible.
  const span100 = totalDurationMs > 0 ? totalDurationMs : 1;
  const leftPct = Math.min(100, (span.offsetMs / span100) * 100);
  const widthPct = Math.max(0.5, Math.min(100 - leftPct, (span.durationMs / span100) * 100));
  return (
    <button
      type="button"
      onClick={() => onSelect?.(span.id)}
      data-testid="waterfall-row"
      className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-[11px] hover:bg-zinc-800/60"
    >
      <span
        className="min-w-0 flex-shrink-0 truncate font-mono text-zinc-300"
        style={{ width: '40%', paddingLeft: `${span.depth * 12}px` }}
        title={span.label}
      >
        <span className="mr-1 text-zinc-500">{span.type}</span>
        {span.label}
      </span>
      <span className="relative h-3 flex-1 rounded bg-zinc-900/60">
        <span
          className={`absolute top-0 h-3 rounded ${colorFor(span.type)}`}
          style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
          title={`${formatMs(span.offsetMs)} +${formatMs(span.durationMs)}`}
        />
      </span>
      <span className="w-16 flex-shrink-0 text-right tabular-nums text-zinc-400">
        {formatMs(span.durationMs)}
      </span>
    </button>
  );
}

export interface WaterfallViewProps {
  waterfall: Waterfall;
  onSelect?: ((id: string) => void) | undefined;
}

/**
 * Renders a nested span waterfall as a flat, indented timeline — each row a bar
 * positioned by its start offset and sized by its duration, indented by nesting
 * depth (Sentry/Tempo style). The bars are derived entirely from the headless
 * `/traces/:id/waterfall` payload.
 */
export function WaterfallView({ waterfall, onSelect }: WaterfallViewProps): JSX.Element {
  const rows = flatten(waterfall.spans);
  if (rows.length === 0) {
    return <p className="text-zinc-600">No spans in this trace</p>;
  }
  return (
    <div className="space-y-0.5">
      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-zinc-500">
        <span>Span</span>
        <span>Total {formatMs(waterfall.totalDurationMs)}</span>
      </div>
      {rows.map((span) => (
        <WaterfallRow
          key={span.id}
          span={span}
          totalDurationMs={waterfall.totalDurationMs}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
