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

const FAIL_BAR = 'var(--bad)';
const OK_BAR = 'var(--good)';

export function toFailureRateBars(report: QueueMetricsReport | undefined): BarChartDatum[] {
  return (report?.queues ?? []).map((queue) => ({
    label: queue.queue,
    value: Number((queue.failureRate * 100).toFixed(1)),
    color: queue.failureRate > 0 ? FAIL_BAR : OK_BAR,
  }));
}

export function QueuesPage(): JSX.Element {
  const [window, setWindow] = useState('1h');
  const { data, isLoading } = useQueues(window);
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm text-brand">Queue metrics</h2>
        <WindowSelect value={window} onChange={setWindow} />
      </div>
      <BarChartCard
        title="Failure rate by queue"
        valueLabel="fail %"
        data={toFailureRateBars(data)}
      />
      {isLoading || !data ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        <QueuesPanel
          report={data}
          sparkline={(queue) => <QueueSparkline queue={queue} window={window} />}
        />
      )}
    </div>
  );
}
