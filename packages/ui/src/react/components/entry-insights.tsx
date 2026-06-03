import { useNavigate } from 'react-router-dom';
import type {
  AreaChartPoint,
  BarChartDatum,
  CacheStats,
  FamilyLatency,
  StatsResult,
  StatusBreakdown,
  TimeseriesReport,
} from '../index.js';
import { useStats } from '../use-telescope-queries.js';
import { AreaChartCard, BarChartCard } from './charts/index.js';

const DEFAULT_WINDOW = '1h';

function formatBucketTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function toAreaSeries(report: TimeseriesReport | undefined): AreaChartPoint[] {
  return (report?.buckets ?? []).map((bucket) => ({
    label: formatBucketTime(bucket.t),
    value: bucket.total,
  }));
}

function StatCard({
  label,
  value,
  accent = 'text-zinc-100',
}: {
  label: string;
  value: string | number;
  accent?: string;
}): JSX.Element {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3">
      <p className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${accent}`}>{value}</p>
    </div>
  );
}

function StatRow({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{children}</div>;
}

function ChartRow({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">{children}</div>;
}

function familyBars(families: FamilyLatency[]): BarChartDatum[] {
  return families.map((family) => ({
    label: family.label !== '' ? family.label : family.familyHash.slice(0, 12),
    value: family.p99,
    id: family.familyHash,
  }));
}

function statusBars(status: StatusBreakdown): BarChartDatum[] {
  return [
    { label: '2xx', value: status['2xx'], color: '#34d399' },
    { label: '3xx', value: status['3xx'], color: '#38bdf8' },
    { label: '4xx', value: status['4xx'], color: '#fbbf24' },
    { label: '5xx', value: status['5xx'], color: '#f87171' },
    { label: 'other', value: status.other, color: '#71717a' },
  ];
}

function cacheKeyBars(cache: CacheStats): BarChartDatum[] {
  return cache.topKeys.map((entry) => ({ label: entry.key, value: entry.count }));
}

function QueryInsights({ stats }: { stats: StatsResult }): JSX.Element {
  const latency = stats.latency;
  const navigate = useNavigate();
  return (
    <>
      <StatRow>
        <StatCard label="Total" value={stats.total.toLocaleString()} />
        <StatCard label="p50 ms" value={latency ? latency.p50.toLocaleString() : '—'} />
        <StatCard
          label="p99 ms"
          value={latency ? latency.p99.toLocaleString() : '—'}
          accent="text-sky-400"
        />
        <StatCard
          label="Slow"
          value={latency ? latency.slow.toLocaleString() : '—'}
          accent={latency && latency.slow > 0 ? 'text-amber-400' : 'text-zinc-100'}
        />
      </StatRow>
      <ChartRow>
        {stats.families ? (
          <BarChartCard
            title="Slowest query shapes (p99)"
            valueLabel="p99 ms"
            data={familyBars(stats.families)}
            horizontal
            truncateLabel={40}
            onBarClick={(datum) => {
              if (datum.id !== undefined) {
                navigate(`/entries/query?familyHash=${encodeURIComponent(datum.id)}`);
              }
            }}
          />
        ) : null}
        <AreaChartCard
          title="Queries over time"
          valueLabel="queries"
          data={toAreaSeries(stats.overTime)}
        />
      </ChartRow>
    </>
  );
}

function CacheInsights({ stats }: { stats: StatsResult }): JSX.Element {
  const cache = stats.cache;
  return (
    <>
      <StatRow>
        <StatCard
          label="Hit ratio"
          value={cache ? `${Math.round(cache.hitRatio * 100)}%` : '—'}
          accent="text-emerald-400"
        />
        <StatCard label="Hits" value={cache ? cache.hits.toLocaleString() : '—'} />
        <StatCard label="Misses" value={cache ? cache.misses.toLocaleString() : '—'} />
        <StatCard label="Sets" value={cache ? cache.sets.toLocaleString() : '—'} />
      </StatRow>
      <ChartRow>
        {cache ? (
          <BarChartCard
            title="Hits vs misses"
            valueLabel="count"
            data={[
              { label: 'hits', value: cache.hits, color: '#34d399' },
              { label: 'misses', value: cache.misses, color: '#f87171' },
            ]}
          />
        ) : null}
        <AreaChartCard
          title="Cache over time"
          valueLabel="ops"
          data={toAreaSeries(stats.overTime)}
        />
      </ChartRow>
      {cache ? (
        <BarChartCard title="Top keys" valueLabel="count" data={cacheKeyBars(cache)} />
      ) : null}
    </>
  );
}

function RequestInsights({ stats }: { stats: StatsResult }): JSX.Element {
  const latency = stats.latency;
  const status = stats.status;
  const errors = status ? status['4xx'] + status['5xx'] : 0;
  const errorPct = stats.total > 0 ? Math.round((errors / stats.total) * 100) : 0;
  return (
    <>
      <StatRow>
        <StatCard label="Total" value={stats.total.toLocaleString()} />
        <StatCard
          label="p99 ms"
          value={latency ? latency.p99.toLocaleString() : '—'}
          accent="text-sky-400"
        />
        <StatCard
          label="Error %"
          value={`${errorPct}%`}
          accent={errors > 0 ? 'text-red-400' : 'text-zinc-100'}
        />
      </StatRow>
      <ChartRow>
        {status ? (
          <BarChartCard title="Status codes" valueLabel="count" data={statusBars(status)} />
        ) : null}
        <AreaChartCard
          title="Throughput"
          valueLabel="requests"
          data={toAreaSeries(stats.overTime)}
        />
      </ChartRow>
    </>
  );
}

function GenericInsights({ stats }: { stats: StatsResult }): JSX.Element {
  return (
    <>
      <StatRow>
        <StatCard label="Total" value={stats.total.toLocaleString()} />
      </StatRow>
      <AreaChartCard title="Over time" valueLabel="entries" data={toAreaSeries(stats.overTime)} />
    </>
  );
}

function InsightsBody({ stats }: { stats: StatsResult }): JSX.Element {
  if (stats.type === 'query') return <QueryInsights stats={stats} />;
  if (stats.type === 'cache') return <CacheInsights stats={stats} />;
  if (stats.type === 'request') return <RequestInsights stats={stats} />;
  return <GenericInsights stats={stats} />;
}

/** Per-type analytics header (stat cards + charts) rendered above the entries table. */
export function EntryInsights({ type }: { type: string }): JSX.Element | null {
  const { data } = useStats(type, DEFAULT_WINDOW);
  if (!data) {
    return (
      <div className="mb-4 h-24 animate-pulse rounded-lg border border-zinc-800 bg-zinc-900/20" />
    );
  }
  return (
    <div className="mb-4 space-y-4">
      <InsightsBody stats={data} />
      {data.truncated ? <p className="text-[10px] text-zinc-600">sampled (window capped)</p> : null}
    </div>
  );
}
