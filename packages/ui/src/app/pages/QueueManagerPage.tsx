import { useEffect, useState } from 'react';
import type { QueueState } from '../../react/index.js';
import {
  JobDetailDrawer,
  JobTable,
  QueueList,
  QueueStateTabs,
  RedriveDlqButton,
  RetryAllFailedButton,
  useLiveQueues,
} from '../../react/index.js';

interface Selection {
  driver: string;
  queue: string;
}

export function QueueManagerPage(): JSX.Element {
  const { data } = useLiveQueues();
  const queues = data?.queues ?? [];
  const capabilities = data?.capabilities;

  const [selected, setSelected] = useState<Selection | undefined>(undefined);
  const [state, setState] = useState<QueueState>('waiting');
  const [openJobId, setOpenJobId] = useState<string | null>(null);

  // Auto-select the first queue once data arrives (if nothing is selected yet).
  useEffect(() => {
    if (selected || queues.length === 0) return;
    const first = queues[0];
    if (first) setSelected({ driver: first.driver, queue: first.queue });
  }, [queues, selected]);

  // Keep counts for the selected queue fresh from the live list (already polled).
  const selectedSummary = queues.find(
    (summary) => summary.driver === selected?.driver && summary.queue === selected?.queue,
  );

  function handleSelect(driver: string, queue: string): void {
    setSelected({ driver, queue });
    setOpenJobId(null);
  }

  return (
    <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="space-y-2">
        <h3 className="px-1 text-[10px] uppercase tracking-wide text-zinc-500">Live queues</h3>
        <QueueList selected={selected} onSelect={handleSelect} />
      </aside>

      <section className="min-w-0 space-y-3">
        {!selected ? (
          <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-12 text-center text-xs text-zinc-600">
            Select a queue to inspect its jobs.
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <h2 className="truncate text-sm text-emerald-400">
                {selected.queue}
                <span className="ml-2 text-[10px] uppercase tracking-wide text-zinc-600">
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
