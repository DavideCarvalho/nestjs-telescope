import type { QueueCounts, QueueState } from '../../../client/index.js';
import { Tabs, TabsList, TabsTab } from '../../ui/index.js';
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
    <Tabs
      value={state}
      onValueChange={(next) => {
        if (typeof next === 'string') onState(next as QueueState);
      }}
    >
      <TabsList>
        {QUEUE_STATE_ORDER.map((candidate) => {
          const active = candidate === state;
          const value = counts?.[candidate] ?? 0;
          return (
            <TabsTab key={candidate} value={candidate}>
              <span className="capitalize">{candidate}</span>
              <span
                className={`tabular-nums text-[11px] ${
                  active ? STATE_ACCENT[candidate] : 'text-muted-foreground'
                }`}
              >
                {value}
              </span>
            </TabsTab>
          );
        })}
      </TabsList>
    </Tabs>
  );
}
