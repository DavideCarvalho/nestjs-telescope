import type { Entry } from '../../client/index.js';
import { entryLabel } from './entries-table.js';
import { dotForType } from './entry-types.js';

/** Max child rows to render before collapsing into a "+N more" note. */
const MAX_ROWS = 50;

/**
 * Compact waterfall of a request's batch: the request plus every child entry
 * (queries, cache, jobs, …) captured during it, ordered by `sequence`. Each row
 * shows a type dot, a short label, a horizontal duration bar scaled to the
 * slowest entry in the batch, and the `durationMs`. This surfaces "where did the
 * time go in this request" without leaving for a trace viewer.
 */
export function RequestTimeline({
  batch,
  requestId,
  onSelect,
}: {
  batch: Entry[];
  requestId: string;
  onSelect?: ((id: string) => void) | undefined;
}): JSX.Element {
  const ordered = [...batch].sort((a, b) => a.sequence - b.sequence);
  const maxDuration = ordered.reduce(
    (max, entry) => (entry.durationMs != null && entry.durationMs > max ? entry.durationMs : max),
    0,
  );
  const visible = ordered.slice(0, MAX_ROWS);
  const hidden = ordered.length - visible.length;

  return (
    <div>
      <ol className="space-y-1">
        {visible.map((entry) => (
          <li key={entry.id}>
            <TimelineRow
              entry={entry}
              maxDuration={maxDuration}
              isRequest={entry.id === requestId}
              onSelect={onSelect}
            />
          </li>
        ))}
      </ol>
      {hidden > 0 ? <p className="mt-1 px-2 text-[10px] text-zinc-600">+{hidden} more</p> : null}
    </div>
  );
}

function TimelineRow({
  entry,
  maxDuration,
  isRequest,
  onSelect,
}: {
  entry: Entry;
  maxDuration: number;
  isRequest: boolean;
  onSelect?: ((id: string) => void) | undefined;
}): JSX.Element {
  // Width is the entry's share of the slowest entry in the batch. Null and
  // zero-duration entries collapse to a minimal sliver so the row still reads.
  const fraction = maxDuration > 0 && entry.durationMs != null ? entry.durationMs / maxDuration : 0;
  const widthPercent = Math.max(0, Math.min(100, fraction * 100));

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onSelect?.(entry.id);
      }}
      className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs ${
        isRequest ? 'bg-zinc-800 text-emerald-300' : 'text-zinc-400 hover:bg-zinc-900'
      }`}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${dotForType(entry.type)}`} aria-hidden />
      <span className="w-40 shrink-0 truncate" title={entryLabel(entry)}>
        {entryLabel(entry)}
      </span>
      <span className="h-2 flex-1 overflow-hidden rounded bg-zinc-900">
        <span
          className="block h-full rounded bg-emerald-500/60"
          style={{ width: `${widthPercent}%` }}
          aria-hidden
        />
      </span>
      <span className="w-12 shrink-0 text-right tabular-nums text-zinc-500">
        {entry.durationMs != null ? `${entry.durationMs}ms` : '—'}
      </span>
    </button>
  );
}
