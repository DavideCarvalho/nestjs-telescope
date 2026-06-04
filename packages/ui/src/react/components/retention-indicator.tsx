import { useMeta } from '../use-telescope-queries.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Format a millisecond duration to a short human string like `500ms`/`30s`/`5m`/`1h`/`2d`. */
export function formatRetention(afterMs: number): string {
  if (afterMs >= DAY) return `${Math.round(afterMs / DAY)}d`;
  if (afterMs >= HOUR) return `${Math.round(afterMs / HOUR)}h`;
  if (afterMs >= MINUTE) return `${Math.round(afterMs / MINUTE)}m`;
  if (afterMs >= SECOND) return `${Math.round(afterMs / SECOND)}s`;
  return `${afterMs}ms`;
}

/** Build a short note like "request sampled @ 25%" for the first type sampled below 1, or null. */
export function samplingNote(sampling: Record<string, number>): string | null {
  for (const [type, rate] of Object.entries(sampling)) {
    if (rate < 1) return `${type} sampled @ ${Math.round(rate * 100)}%`;
  }
  return null;
}

/**
 * Subtle header indicator surfacing the configured retention window (or "none"
 * when unbounded) plus a tooltip hint when any entry type is down-sampled.
 */
export function RetentionIndicator(): JSX.Element | null {
  const { data: meta } = useMeta();
  if (!meta) return null;
  const note = samplingNote(meta.sampling ?? {});
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-zinc-500" title={note ?? undefined}>
      <span className="uppercase tracking-wide text-zinc-600">retention:</span>
      {meta.retention ? (
        <span className="text-zinc-400">{formatRetention(meta.retention.afterMs)}</span>
      ) : (
        <span className="text-zinc-600">none</span>
      )}
      {note ? (
        <span
          aria-label={note}
          className="cursor-help rounded-full border border-zinc-700 px-1 text-[9px] text-zinc-500"
        >
          ?
        </span>
      ) : null}
    </span>
  );
}
