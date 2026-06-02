import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PulsePanel, Sparkline, WindowSelect, usePulse, useTimeseries } from '../../react/index.js';

export function PulsePage(): JSX.Element {
  const [window, setWindow] = useState('1h');
  const navigate = useNavigate();
  const { data, isLoading } = usePulse(window);
  const series = useTimeseries({ window, buckets: 60 });
  return (
    <div className="p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm text-emerald-400">Pulse</h2>
        <WindowSelect value={window} onChange={setWindow} />
      </div>
      <div className="mb-6">
        <p className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Throughput</p>
        <Sparkline
          values={(series.data?.buckets ?? []).map((bucket) => bucket.total)}
          width={640}
          height={48}
        />
      </div>
      {isLoading || !data ? (
        <p className="text-zinc-600">Loading…</p>
      ) : (
        <PulsePanel report={data} onSelectEntry={(id) => navigate(`/entries/${id}`)} />
      )}
    </div>
  );
}
