import type { QueueCounts, QueueState } from '../../../client/index.js';
import { QUEUE_STATE_ORDER, STATE_ACCENT } from './queue-format.js';

export function QueueStateTabs({
  counts,
  state,
  onState,
}: {
  counts: QueueCounts | undefined;
  state: QueueState;
  onState: (state: QueueState) => void;
}): JSX.Element {
  return (
    <div className="flex flex-wrap gap-1 border-b border-zinc-800 pb-2">
      {QUEUE_STATE_ORDER.map((candidate) => {
        const active = candidate === state;
        const value = counts?.[candidate] ?? 0;
        return (
          <button
            key={candidate}
            type="button"
            onClick={() => onState(candidate)}
            className={`flex items-baseline gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors ${
              active
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300'
            }`}
          >
            <span className="capitalize">{candidate}</span>
            <span
              className={`tabular-nums text-[11px] ${
                active ? STATE_ACCENT[candidate] : 'text-zinc-600'
              }`}
            >
              {value}
            </span>
          </button>
        );
      })}
    </div>
  );
}
