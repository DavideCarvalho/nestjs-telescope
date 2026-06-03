import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  PulsePanel,
  StackedAreaChartCard,
  WindowSelect,
  deriveTypes,
  usePulse,
  useTimeseries,
} from '../../react/index.js';
import { toByTypeRows } from './OverviewPage.js';

export function PulsePage(): JSX.Element {
  const [window, setWindow] = useState('1h');
  const navigate = useNavigate();
  const { data, isLoading } = usePulse(window);
  const series = useTimeseries({ window, buckets: 60 });
  const types = deriveTypes(series.data?.buckets ?? []);
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm text-emerald-400">Pulse</h2>
        <WindowSelect value={window} onChange={setWindow} />
      </div>
      <StackedAreaChartCard
        title="Throughput by type"
        series={types}
        data={toByTypeRows(series.data)}
      />
      {isLoading || !data ? (
        <p className="text-zinc-600">Loading…</p>
      ) : (
        <PulsePanel report={data} onSelectEntry={(id) => navigate(`/entries/${id}`)} />
      )}
    </div>
  );
}
