import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AreaChartCard,
  type AreaChartPoint,
  StackedAreaChartCard,
  type StackedAreaRow,
  WindowSelect,
  deriveTypes,
  usePulse,
  useQueues,
  useServerStats,
  useTimeseries,
} from '../../react/index.js';
import type {
  PulseReport,
  QueueMetricsReport,
  ServerStats,
  TimeseriesReport,
} from '../../react/index.js';

function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${total % 60}s`;
}

function ServerStatsCard({ stats }: { stats: ServerStats | undefined }): JSX.Element {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-zinc-400">Server</h3>
      {stats ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatCard
            label="Uptime"
            value={formatUptime(stats.uptimeSec)}
            accent="text-emerald-400"
          />
          <StatCard
            label="RSS"
            value={`${stats.memory.rssMb} MB`}
            hint={`heap ${stats.memory.heapUsedMb}/${stats.memory.heapTotalMb} MB`}
          />
          <StatCard
            label="Heap used"
            value={`${stats.memory.heapUsedMb} MB`}
            accent="text-sky-400"
          />
          <StatCard
            label="CPU"
            value={`${Math.round(stats.cpu.userMs)} ms`}
            accent="text-violet-400"
            hint={`sys ${Math.round(stats.cpu.systemMs)} ms`}
          />
          <StatCard
            label="Event loop"
            value={stats.eventLoopDelayMs === null ? 'n/a' : `${stats.eventLoopDelayMs} ms`}
            accent={
              stats.eventLoopDelayMs !== null && stats.eventLoopDelayMs > 100
                ? 'text-red-400'
                : 'text-zinc-100'
            }
            hint={`instance ${stats.instanceId}`}
          />
        </div>
      ) : (
        <p className="text-xs text-zinc-600">Loading…</p>
      )}
    </section>
  );
}

function formatBucketTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function toThroughputSeries(report: TimeseriesReport | undefined): AreaChartPoint[] {
  return (report?.buckets ?? []).map((bucket) => ({
    label: formatBucketTime(bucket.t),
    value: bucket.total,
  }));
}

export function toByTypeRows(report: TimeseriesReport | undefined): StackedAreaRow[] {
  const types = deriveTypes(report?.buckets ?? []);
  return (report?.buckets ?? []).map((bucket) => {
    const row: StackedAreaRow = { label: formatBucketTime(bucket.t) };
    for (const type of types) row[type] = bucket.byType[type] ?? 0;
    return row;
  });
}

function sumCounts(counts: Record<string, number>): number {
  return Object.values(counts).reduce((acc, value) => acc + value, 0);
}

function StatCard({
  label,
  value,
  accent = 'text-zinc-100',
  hint,
}: {
  label: string;
  value: string | number;
  accent?: string;
  hint?: string;
}): JSX.Element {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3">
      <p className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${accent}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[10px] text-zinc-600">{hint}</p>}
    </div>
  );
}

function StatCards({
  pulse,
  queues,
}: {
  pulse: PulseReport | undefined;
  queues: QueueMetricsReport | undefined;
}): JSX.Element {
  const counts = pulse?.counts ?? {};
  const totalEntries = sumCounts(counts);
  const requests = counts.request ?? 0;
  const exceptions = counts.exception ?? 0;
  const jobs = counts.job ?? 0;
  const failedJobs = (queues?.queues ?? []).reduce((acc, queue) => acc + queue.failed, 0);
  const throughput = (queues?.queues ?? []).reduce(
    (acc, queue) => acc + queue.throughputPerMinute,
    0,
  );
  const slowCount = pulse?.slowest.length ?? 0;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <StatCard label="Entries" value={totalEntries.toLocaleString()} hint="all types in window" />
      <StatCard label="Requests" value={requests.toLocaleString()} accent="text-emerald-400" />
      <StatCard
        label="Exceptions"
        value={exceptions.toLocaleString()}
        accent={exceptions > 0 ? 'text-red-400' : 'text-zinc-100'}
      />
      <StatCard label="Jobs" value={jobs.toLocaleString()} accent="text-violet-400" />
      <StatCard
        label="Jobs / min"
        value={throughput.toFixed(1)}
        accent="text-sky-400"
        hint="across queues"
      />
      <StatCard
        label="Failed jobs"
        value={failedJobs.toLocaleString()}
        accent={failedJobs > 0 ? 'text-red-400' : 'text-zinc-100'}
        hint={`${slowCount} slow`}
      />
    </div>
  );
}

function ListCard({
  title,
  emptyLabel,
  children,
}: {
  title: string;
  emptyLabel: string;
  children: React.ReactNode;
}): JSX.Element {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-zinc-400">{title}</h3>
      {hasChildren ? (
        <ul className="space-y-1 text-xs">{children}</ul>
      ) : (
        <p className="text-xs text-zinc-600">{emptyLabel}</p>
      )}
    </section>
  );
}

export function OverviewPage(): JSX.Element {
  const [window, setWindow] = useState('1h');
  const navigate = useNavigate();
  const pulse = usePulse(window);
  const queues = useQueues(window);
  const series = useTimeseries({ window, buckets: 60 });
  const serverStats = useServerStats();

  const throughput = toThroughputSeries(series.data);
  const byTypeRows = toByTypeRows(series.data);
  const types = deriveTypes(series.data?.buckets ?? []);

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm text-emerald-400">Overview</h2>
        <WindowSelect value={window} onChange={setWindow} />
      </div>

      <StatCards pulse={pulse.data} queues={queues.data} />

      <ServerStatsCard stats={serverStats.data} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <AreaChartCard title="Throughput" valueLabel="entries" data={throughput} />
        <StackedAreaChartCard title="By type" series={types} data={byTypeRows} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ListCard title="Recent failures" emptyLabel="No exceptions 🎉">
          {(pulse.data?.topExceptions ?? []).map((group) => (
            <li
              key={group.familyHash}
              className="flex items-center justify-between gap-3 border-t border-zinc-900 pt-1 first:border-0 first:pt-0"
            >
              <span className="min-w-0">
                <span className="text-red-400">{group.class}</span>{' '}
                <span className="text-zinc-400">{group.message}</span>
              </span>
              <span className="shrink-0 tabular-nums text-zinc-500">×{group.count}</span>
            </li>
          ))}
        </ListCard>

        <ListCard title="Slowest" emptyLabel="Nothing slow in window.">
          {(pulse.data?.slowest ?? []).map((slow) => (
            <li key={slow.id}>
              <button
                type="button"
                onClick={() => navigate(`/entries/view/${slow.id}`)}
                className="flex w-full items-center justify-between gap-3 border-t border-zinc-900 pt-1 text-left hover:text-zinc-100 first:border-0 first:pt-0"
              >
                <span className="min-w-0 truncate">
                  <span className="text-emerald-400">{slow.type}</span>{' '}
                  <span className="text-zinc-400">{slow.label}</span>
                </span>
                <span className="shrink-0 tabular-nums text-zinc-500">{slow.durationMs}ms</span>
              </button>
            </li>
          ))}
        </ListCard>
      </div>
    </div>
  );
}
