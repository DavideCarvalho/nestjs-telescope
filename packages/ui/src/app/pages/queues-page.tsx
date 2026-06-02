import { useState } from 'react';
import { QueuesPanel, WindowSelect, useQueues } from '../../react/index.js';

export function QueuesPage(): JSX.Element {
  const [window, setWindow] = useState('1h');
  const { data, isLoading } = useQueues(window);
  return (
    <div className="p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm text-emerald-400">Queues</h2>
        <WindowSelect value={window} onChange={setWindow} />
      </div>
      {isLoading || !data ? (
        <p className="text-zinc-600">Loading…</p>
      ) : (
        <QueuesPanel report={data} />
      )}
    </div>
  );
}
