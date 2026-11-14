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
import { RowsSkeleton, TelescopePage } from '../page-chrome.js';
import { toByTypeRows } from './OverviewPage.js';

export function PulsePage(): React.JSX.Element {
  const [window, setWindow] = useState('1h');
  const navigate = useNavigate();
  const { data, isLoading } = usePulse(window);
  const series = useTimeseries({ window, buckets: 60 });
  const types = deriveTypes(series.data?.buckets ?? []);
  return (
    <TelescopePage
      title="Pulse"
      description="Throughput by type, the slowest routes and queries, top exceptions and N+1 hotspots."
      actions={<WindowSelect value={window} onChange={setWindow} />}
    >
      <StackedAreaChartCard
        title="Throughput by type"
        series={types}
        data={toByTypeRows(series.data)}
      />
      {isLoading || !data ? (
        <RowsSkeleton rows={6} />
      ) : (
        <PulsePanel
          report={data}
          onSelectEntry={(id) => navigate(`/entries/view/${id}`)}
          onSelectFamily={(familyHash) =>
            navigate(`/entries/query?familyHash=${encodeURIComponent(familyHash)}`)
          }
          onSelectRoute={(route) =>
            navigate(`/entries/request?familyHash=${encodeURIComponent(route)}`)
          }
          onSelectOutgoing={(route) =>
            navigate(`/entries/http_client?familyHash=${encodeURIComponent(route)}`)
          }
        />
      )}
    </TelescopePage>
  );
}
