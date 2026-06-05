import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AreaChartCard,
  type AreaChartPoint,
  StackedAreaChartCard,
  type StackedAreaRow,
  WindowSelect,
  deriveTypes,
  formatRetention,
  useHealth,
  useMeta,
  usePrune,
  usePulse,
  useQueues,
  useRetention,
  useServerStats,
  useTimeseries,
} from '../../react/index.js';
import type {
  NPlusOneHotspot,
  PulseReport,
  QueueMetrics,
  QueueMetricsReport,
  RetentionInfo,
  ServerStats,
  TelescopeHealth,
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

function formatMicros(nanos: number): string {
  const micros = Math.max(0, nanos) / 1000;
  return `${micros.toFixed(1)} µs`;
}

function formatFlushMs(ms: number | null): string {
  return ms === null ? 'n/a' : `${ms.toFixed(1)} ms`;
}

function TelescopeHealthCard({ health }: { health: TelescopeHealth | undefined }): JSX.Element {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-400">
          Telescope health
        </h3>
        <span className="text-[10px] text-zinc-600">
          Captures run off the response path — your requests don&apos;t wait on Telescope.
        </span>
      </div>
      {health ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard
            label="Capture cost"
            value={`${formatMicros(health.captureCostNanos)}/capture`}
            accent="text-emerald-400"
            hint="micro-benchmark"
          />
          <StatCard
            label="Buffer"
            value={`${health.bufferUsed} / ${health.bufferSize}`}
            accent="text-sky-400"
            hint={`high-water ${health.bufferHighWater}`}
          />
          <StatCard
            label="Last flush"
            value={formatFlushMs(health.lastFlushMs)}
            hint={`max ${formatFlushMs(health.maxFlushMs)}`}
          />
          <StatCard
            label="Flushes"
            value={health.flushes.toLocaleString()}
            accent="text-violet-400"
            hint={`${health.flushedEntries.toLocaleString()} entries`}
          />
          <StatCard
            label="Dropped"
            value={health.droppedCount.toLocaleString()}
            accent={health.droppedCount > 0 ? 'text-red-400' : 'text-emerald-400'}
            hint={
              health.droppedCount > 0
                ? `overflow ${health.overflowDropped} · store ${health.storeFailedDropped}`
                : 'keeping up'
            }
          />
          <StatCard
            label="Truncated"
            value={health.truncatedCount.toLocaleString()}
            accent={health.truncatedCount > 0 ? 'text-amber-400' : 'text-emerald-400'}
            hint={
              health.truncatedCount > 0 ? 'fat content — tune redact/sampling' : 'within bounds'
            }
          />
        </div>
      ) : (
        <p className="text-xs text-zinc-600">Loading…</p>
      )}
    </section>
  );
}

function RetentionCard({
  retention,
  pruneEnabled,
}: {
  retention: RetentionInfo | undefined;
  pruneEnabled: boolean;
}): JSX.Element {
  const prune = usePrune();
  const window = retention?.retention;

  async function onPrune(): Promise<void> {
    if (
      !globalThis.confirm('Prune now deletes entries older than the retention window. Continue?')
    ) {
      return;
    }
    try {
      const result = await prune.mutateAsync();
      globalThis.alert(`Pruned ${result.pruned} ${result.pruned === 1 ? 'entry' : 'entries'}.`);
    } catch {
      globalThis.alert('Prune failed.');
    }
  }

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-400">Retention</h3>
        {pruneEnabled ? (
          <button
            type="button"
            onClick={onPrune}
            disabled={prune.isPending}
            className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:border-emerald-500 hover:text-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {prune.isPending ? 'Pruning…' : 'Prune now'}
          </button>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard
          label="Window"
          value={window ? formatRetention(window.afterMs) : 'none'}
          accent={window ? 'text-emerald-400' : 'text-zinc-500'}
          hint={window?.keepLast != null ? `keep last ${window.keepLast}` : 'unbounded'}
        />
        <StatCard
          label="Entries"
          value={retention?.entryCount != null ? retention.entryCount.toLocaleString() : 'n/a'}
        />
        <StatCard label="Oldest" value={retention?.oldestCreatedAt != null ? 'tracked' : 'n/a'} />
      </div>
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

/**
 * Error rate over the window = exceptions ÷ requests, as a fraction in [0, 1].
 * Both inputs come from the pulse `counts` map already on the overview — no new
 * endpoint. Returns `null` when there were no requests (rate is undefined, not
 * zero — showing 0% would falsely imply "healthy" on an idle window).
 */
export function deriveErrorRate(counts: Record<string, number>): number | null {
  const requests = counts.request ?? 0;
  if (requests === 0) return null;
  return (counts.exception ?? 0) / requests;
}

/** Above this fraction the error-rate stat turns red. */
export const ERROR_RATE_ALERT_THRESHOLD = 0.05;

/** `12.3%` / `n/a` rendering for an error-rate fraction (or `null`). */
export function formatErrorRate(rate: number | null): string {
  if (rate === null) return 'n/a';
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * Slow request count = number of slow-route families pulse flagged for the
 * window. `slowRoutes` is pulse's p99-over-threshold route list, so its length
 * is a cheap "how many endpoints are slow right now" figure derived from data
 * already fetched — no extra scan.
 */
export function deriveSlowRequestCount(report: PulseReport | undefined): number {
  return report?.slowRoutes.length ?? 0;
}

/** A queue waiting backlog at/above this is "needs attention" even with no failures. */
export const QUEUE_WAITING_ATTENTION_THRESHOLD = 100;

/**
 * Queues that need an operator's eyes: any with failed jobs in the window, or a
 * large pending backlog. The overview's `useQueues` payload (`QueueMetrics`)
 * exposes per-queue `failed` and `total`/`completed` but no live `waiting`
 * gauge (that's only on `/queues/live`), so we approximate the backlog as
 * `total − completed − failed` (jobs neither finished nor failed yet). Pure and
 * order-stable so it's unit-testable; returns `[]` when everything is clean.
 */
export function queuesNeedingAttention(report: QueueMetricsReport | undefined): QueueMetrics[] {
  return (report?.queues ?? []).filter((queue) => {
    const pending = Math.max(0, queue.total - queue.completed - queue.failed);
    return queue.failed > 0 || pending >= QUEUE_WAITING_ATTENTION_THRESHOLD;
  });
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

/**
 * Criticality-first stat row — "what's wrong right now" at a glance. Requests
 * frames the volume; the other three are the operational red flags (errors,
 * failed jobs, slow endpoints), each turning red when non-zero / over threshold.
 * Entries total moves to a hint on Requests so the row stays focused. Every
 * figure is derived from data already served by /api/pulse + /api/queues.
 */
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
  const errorRate = deriveErrorRate(counts);
  const failedJobs = (queues?.queues ?? []).reduce((acc, queue) => acc + queue.failed, 0);
  const slowRequests = deriveSlowRequestCount(pulse);
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatCard
        label="Requests"
        value={requests.toLocaleString()}
        accent="text-emerald-400"
        hint={`${totalEntries.toLocaleString()} entries total`}
      />
      <StatCard
        label="Error rate"
        value={formatErrorRate(errorRate)}
        accent={
          errorRate !== null && errorRate > ERROR_RATE_ALERT_THRESHOLD
            ? 'text-red-400'
            : 'text-zinc-100'
        }
        hint={`${exceptions.toLocaleString()} exceptions`}
      />
      <StatCard
        label="Failed jobs"
        value={failedJobs.toLocaleString()}
        accent={failedJobs > 0 ? 'text-red-400' : 'text-zinc-100'}
        hint="across queues"
      />
      <StatCard
        label="Slow requests"
        value={slowRequests.toLocaleString()}
        accent={slowRequests > 0 ? 'text-amber-400' : 'text-zinc-100'}
        hint="routes over p99 budget"
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

/**
 * N+1 query hotspots — the same detection PulsePanel renders, surfaced as its
 * own overview card (PulsePanel bundles slowest/exceptions/routes too, which
 * already have dedicated overview cards, so we mount only the N+1 part here).
 * Rows pivot to the offending query family, mirroring PulsePanel's behavior.
 */
function NPlusOneCard({
  hotspots,
  onSelectFamily,
}: {
  hotspots: NPlusOneHotspot[];
  onSelectFamily: (familyHash: string) => void;
}): JSX.Element {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-zinc-400">
        N+1 query hotspots
      </h3>
      {hotspots.length > 0 ? (
        <ul className="space-y-1 text-xs">
          {hotspots.map((hotspot) => (
            <li key={hotspot.familyHash}>
              <button
                type="button"
                onClick={() => onSelectFamily(hotspot.familyHash)}
                className="flex w-full items-center justify-between gap-3 border-t border-zinc-900 pt-1 text-left hover:text-zinc-100 first:border-0 first:pt-0"
              >
                <span className="min-w-0 truncate">
                  <span className="whitespace-nowrap text-amber-400">×{hotspot.perRequest}</span>{' '}
                  <span className="text-zinc-400">{hotspot.sql}</span>
                </span>
                <span className="shrink-0 tabular-nums text-zinc-500">
                  {hotspot.requests} req · {hotspot.total} total
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-zinc-600">None detected</p>
      )}
    </section>
  );
}

/**
 * Queues needing attention — a compact triage card listing only queues with
 * failed jobs or a large backlog (see `queuesNeedingAttention`). Each row links
 * to the queues page. Renders a reassuring one-liner when everything's clean so
 * the card never becomes dead space.
 */
function QueuesAttentionCard({
  queues,
  onOpenQueues,
}: {
  queues: QueueMetrics[];
  onOpenQueues: () => void;
}): JSX.Element {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-400">
          Queues needing attention
        </h3>
        <button
          type="button"
          onClick={onOpenQueues}
          className="text-[11px] text-zinc-500 hover:text-emerald-400"
        >
          All queues →
        </button>
      </div>
      {queues.length > 0 ? (
        <ul className="space-y-1 text-xs">
          {queues.map((queue) => {
            const pending = Math.max(0, queue.total - queue.completed - queue.failed);
            return (
              <li key={queue.queue}>
                <button
                  type="button"
                  onClick={onOpenQueues}
                  className="flex w-full items-center justify-between gap-3 border-t border-zinc-900 pt-1 text-left hover:text-zinc-100 first:border-0 first:pt-0"
                >
                  <span className="min-w-0 truncate text-zinc-300">{queue.queue}</span>
                  <span className="shrink-0 tabular-nums">
                    {queue.failed > 0 ? (
                      <span className="text-red-400">{queue.failed} failed</span>
                    ) : null}
                    {queue.failed > 0 && pending >= QUEUE_WAITING_ATTENTION_THRESHOLD ? (
                      <span className="text-zinc-600"> · </span>
                    ) : null}
                    {pending >= QUEUE_WAITING_ATTENTION_THRESHOLD ? (
                      <span className="text-amber-400">{pending.toLocaleString()} pending</span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-emerald-400/80">All queues healthy</p>
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
  const health = useHealth();
  const retention = useRetention();
  const meta = useMeta();

  const throughput = toThroughputSeries(series.data);
  const byTypeRows = toByTypeRows(series.data);
  const types = deriveTypes(series.data?.buckets ?? []);
  const attentionQueues = queuesNeedingAttention(queues.data);

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm text-emerald-400">Overview</h2>
        <WindowSelect value={window} onChange={setWindow} />
      </div>

      {/*
        TOP — "what's wrong right now": the criticality stat row, then recent
        failures, N+1 hotspots, slowest, and queues needing attention. This is
        the above-the-fold operational triage surface.
      */}
      <StatCards pulse={pulse.data} queues={queues.data} />

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

        <NPlusOneCard
          hotspots={pulse.data?.nPlusOne ?? []}
          onSelectFamily={(familyHash) =>
            navigate(`/entries/query?familyHash=${encodeURIComponent(familyHash)}`)
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
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

        <QueuesAttentionCard queues={attentionQueues} onOpenQueues={() => navigate('/queues')} />
      </div>

      {/*
        BOTTOM — trends & self-health: throughput, composition by type, and
        Telescope's own server/health/retention diagnostics. Informational, so
        it sits below the operational triage cards.
      */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <AreaChartCard title="Throughput" valueLabel="entries" data={throughput} />
        <StackedAreaChartCard title="By type" series={types} data={byTypeRows} />
      </div>

      <ServerStatsCard stats={serverStats.data} />

      <TelescopeHealthCard health={health.data} />

      <RetentionCard retention={retention.data} pruneEnabled={meta.data?.pruneEnabled ?? false} />
    </div>
  );
}
