import { parseAsString, parseAsStringLiteral, useQueryStates } from 'nuqs';
import { useEffect, useState } from 'react';
import { QUEUE_STATE_ORDER } from '../../react/components/queues/queue-format.js';
import {
  EnqueueJobForm,
  JobDetailDrawer,
  JobTable,
  QueueList,
  QueueStateTabs,
  RedriveDlqButton,
  RetryAllFailedButton,
  useLiveQueues,
} from '../../react/index.js';

/**
 * The open queue and its state tab in the URL: `#/queues?driver=bullmq&queue=emails&state=failed`.
 * No queue param opens the first queue; `waiting` is the default tab.
 */
const QUEUE_VIEW = {
  driver: parseAsString,
  queue: parseAsString,
  state: parseAsStringLiteral(QUEUE_STATE_ORDER).withDefault('waiting'),
};

export function QueueManagerPage(): React.JSX.Element {
  const { data } = useLiveQueues();
  const queues = data?.queues ?? [];
  const capabilities = data?.capabilities;

  const [view, setView] = useQueryStates(QUEUE_VIEW);
  const { state } = view;
  const selected =
    view.driver !== null && view.queue !== null
      ? { driver: view.driver, queue: view.queue }
      : undefined;
  const [openJobId, setOpenJobId] = useState<string | null>(null);

  // Auto-select the first queue once data arrives (if nothing is selected yet). It rewrites the
  // current history entry: Back leaves the page rather than returning to "no queue".
  useEffect(() => {
    if (selected || queues.length === 0) return;
    const first = queues[0];
    if (first) void setView({ driver: first.driver, queue: first.queue });
  }, [queues, selected, setView]);

  function setState(next: (typeof QUEUE_STATE_ORDER)[number]): void {
    void setView({ state: next }, { history: 'push' });
  }

  // Keep counts for the selected queue fresh from the live list (already polled).
  const selectedSummary = queues.find(
    (summary) => summary.driver === selected?.driver && summary.queue === selected?.queue,
  );

  function handleSelect(driver: string, queue: string): void {
    void setView({ driver, queue }, { history: 'push' });
    setOpenJobId(null);
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="space-y-2">
        <h3 className="px-1 text-[10px] uppercase tracking-[0.12em] text-faint">Live queues</h3>
        <QueueList {...(selected ? { selected } : {})} onSelect={handleSelect} />
      </aside>

      <section className="min-w-0 space-y-3">
        {!selected ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-12 text-center text-xs text-faint">
            Select a queue to inspect its jobs.
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <h2 className="truncate text-sm font-semibold text-fg">
                {selected.queue}
                <span className="ml-2 text-[10px] uppercase tracking-[0.12em] text-faint">
                  {selected.driver}
                </span>
              </h2>
              {state === 'failed' && (
                <div className="flex items-center gap-2">
                  <RetryAllFailedButton
                    capabilities={capabilities}
                    driver={selected.driver}
                    queue={selected.queue}
                  />
                  <RedriveDlqButton
                    capabilities={capabilities}
                    driver={selected.driver}
                    queue={selected.queue}
                  />
                </div>
              )}
            </div>

            <QueueStateTabs counts={selectedSummary?.counts} state={state} onState={setState} />

            <JobTable
              driver={selected.driver}
              queue={selected.queue}
              state={state}
              onOpen={setOpenJobId}
            />

            <EnqueueJobForm
              capabilities={capabilities}
              driver={selected.driver}
              queue={selected.queue}
            />
          </>
        )}
      </section>

      {selected && openJobId && (
        <JobDetailDrawer
          driver={selected.driver}
          queue={selected.queue}
          jobId={openJobId}
          state={state}
          capabilities={capabilities}
          onClose={() => setOpenJobId(null)}
        />
      )}
    </div>
  );
}
