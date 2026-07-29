import type { QueueState, QueueSummary } from '../../../client/index.js';
import { useLiveQueues } from '../../use-telescope-queries.js';
import { QUEUE_STATE_ORDER, STATE_ACCENT } from './queue-format.js';

function CountBadge({
  state,
  value,
}: {
  state: QueueState;
  value: number;
}): JSX.Element {
  const emphasize = state === 'failed' && value > 0;
  return (
    <span
      className={`flex items-baseline gap-1 rounded px-1.5 py-0.5 ${
        emphasize ? 'tint-bad' : 'bg-panel-2/60'
      }`}
      title={`${value} ${state}`}
    >
      <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
        {state.slice(0, 4)}
      </span>
      <span className={`tabular-nums ${value > 0 ? STATE_ACCENT[state] : 'text-muted-foreground'}`}>
        {value}
      </span>
    </span>
  );
}

function QueueRow({
  summary,
  active,
  onSelect,
}: {
  summary: QueueSummary;
  active: boolean;
  onSelect: (driver: string, queue: string) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onSelect(summary.driver, summary.queue)}
      className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
        active
          ? 'border-brand bg-panel-2'
          : 'border-line bg-panel/40 hover:border-line hover:bg-panel'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-medium text-foreground">{summary.queue}</span>
        {summary.isPaused && (
          <span className="shrink-0 rounded bg-violet-500/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-violet-300">
            paused
          </span>
        )}
      </div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        {summary.driver}
      </div>
      <div className="mt-2 flex flex-wrap gap-1 text-[10px]">
        {QUEUE_STATE_ORDER.map((state) => (
          <CountBadge key={state} state={state} value={summary.counts[state]} />
        ))}
      </div>
    </button>
  );
}

export function QueueList({
  selected,
  onSelect,
}: {
  selected?: { driver: string; queue: string };
  onSelect: (driver: string, queue: string) => void;
}): JSX.Element {
  const { data, isLoading, isError } = useLiveQueues();

  if (isLoading) {
    return <p className="px-1 py-2 text-xs text-muted-foreground">Loading queues…</p>;
  }
  if (isError) {
    return <p className="px-1 py-2 text-xs text-bad">Failed to load queues.</p>;
  }
  const queues = data?.queues ?? [];
  if (queues.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs text-muted-foreground">
        No live queues detected.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {queues.map((summary) => (
        <QueueRow
          key={`${summary.driver}:${summary.queue}`}
          summary={summary}
          active={selected?.driver === summary.driver && selected?.queue === summary.queue}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
