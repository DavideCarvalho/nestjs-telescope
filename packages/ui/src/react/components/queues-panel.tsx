import type { DurationStats, QueueMetricsReport } from '../../client/index.js';

function p95(stats: DurationStats | null): string {
  return stats ? `${Math.round(stats.p95)}ms` : '—';
}

export function QueuesPanel({
  report,
  sparkline,
}: {
  report: QueueMetricsReport;
  sparkline?: (queue: string) => React.ReactNode;
}): JSX.Element {
  return (
    <table className="w-full text-left text-xs">
      <thead className="text-zinc-500">
        <tr>
          <th className="py-2 font-normal">Queue</th>
          <th className="font-normal">Total</th>
          <th className="font-normal">Failed</th>
          <th className="font-normal">Fail %</th>
          <th className="font-normal">Per min</th>
          <th className="font-normal">Runtime p95</th>
          <th className="font-normal">Wait p95</th>
          {sparkline && <th className="font-normal">Trend</th>}
        </tr>
      </thead>
      <tbody>
        {report.queues.map((q) => (
          <tr key={q.queue} className="border-t border-zinc-900">
            <td className="py-1.5 text-emerald-400">{q.queue}</td>
            <td className="text-zinc-300">{q.total}</td>
            <td className="text-zinc-300">{q.failed}</td>
            <td className={q.failureRate > 0 ? 'text-red-400' : 'text-zinc-500'}>
              {(q.failureRate * 100).toFixed(1)}%
            </td>
            <td className="text-zinc-400">{q.throughputPerMinute.toFixed(1)}</td>
            <td className="text-zinc-400">{p95(q.runtimeMs)}</td>
            <td className="text-zinc-400">{p95(q.waitMs)}</td>
            {sparkline && <td className="text-zinc-400">{sparkline(q.queue)}</td>}
          </tr>
        ))}
        {report.queues.length === 0 && (
          <tr>
            <td className="py-2 text-zinc-600" colSpan={sparkline ? 8 : 7}>
              No queue activity in window.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
