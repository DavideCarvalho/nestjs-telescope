import { useState } from 'react';
import {
  BarChartCard,
  type BarChartDatum,
  type QueueMetricsReport,
  QueueSparkline,
  QueuesPanel,
  WindowSelect,
  useQueues,
} from '../../react/index.js';
import { RowsSkeleton } from '../page-chrome.js';

const FAIL_BAR = 'var(--aviary-bad)';
const OK_BAR = 'var(--aviary-good)';

export function toFailureRateBars(report: QueueMetricsReport | undefined): BarChartDatum[] {
  return (report?.queues ?? []).map((queue) => ({
    label: queue.queue,
    value: Number((queue.failureRate * 100).toFixed(1)),
    color: queue.failureRate > 0 ? FAIL_BAR : OK_BAR,
  }));
}

export function QueuesPage(): React.JSX.Element {
  const [window, setWindow] = useState('1h');
  const { data, isLoading } = useQueues(window);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end">
        <WindowSelect value={window} onChange={setWindow} />
      </div>
      <BarChartCard
        title="Failure rate by queue"
        valueLabel="fail %"
        data={toFailureRateBars(data)}
      />
      {isLoading || !data ? (
        <RowsSkeleton rows={4} />
      ) : (
        <QueuesPanel
          report={data}
          sparkline={(queue) => <QueueSparkline queue={queue} window={window} />}
        />
      )}
    </div>
  );
}
