import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  PulsePanel,
  StackedBars,
  TYPE_COLOR,
  WindowSelect,
  deriveTypes,
  usePulse,
  useTimeseries,
} from '../../react/index.js';

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
        <div className="mb-1 flex items-center justify-between">
          <p className="text-xs uppercase tracking-wide text-zinc-500">Throughput by type</p>
          <div className="flex gap-2 text-[10px] text-zinc-500">
            {deriveTypes(series.data?.buckets ?? []).map((type) => (
              <span key={type} className="flex items-center gap-1">
                <svg width={8} height={8} aria-hidden="true">
                  <rect width={8} height={8} className={TYPE_COLOR[type] ?? 'fill-zinc-500'} />
                </svg>
                {type}
              </span>
            ))}
          </div>
        </div>
        <StackedBars buckets={series.data?.buckets ?? []} width={640} height={48} />
      </div>
      {isLoading || !data ? (
        <p className="text-zinc-600">Loading…</p>
      ) : (
        <PulsePanel report={data} onSelectEntry={(id) => navigate(`/entries/${id}`)} />
      )}
    </div>
  );
}
