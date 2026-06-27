import { useEffect, useState } from 'react';
import type { PruneRun, PrunesConfig } from '../../client/index.js';
import { StatCard } from '../../react/components/extensions/stat-card.js';
import {
  formatRetention,
  labelForType,
  relativeTime,
  useMeta,
  usePrune,
  usePrunes,
} from '../../react/index.js';

const TRIGGER_ACCENT: Record<PruneRun['trigger'], string> = {
  scheduled: 'text-sky-300 bg-sky-500/10',
  manual: 'text-amber-300 bg-amber-500/10',
};

function TriggerBadge({ trigger }: { trigger: PruneRun['trigger'] }): JSX.Element {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${TRIGGER_ACCENT[trigger]}`}
    >
      {trigger}
    </span>
  );
}

function TypeChip({ type, count }: { type: string; count: number }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-zinc-800/80 px-1.5 py-0.5 text-[10px] text-zinc-300">
      <span className="text-zinc-500">{labelForType(type)}</span>
      <span className="tabular-nums text-zinc-100">{count}</span>
    </span>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Coarse countdown to the next scheduled prune, recomputed each second. */
function formatCountdown(nextRunAt: string | null, nowMs: number): string {
  if (nextRunAt === null) return '—';
  const deltaMs = new Date(nextRunAt).getTime() - nowMs;
  if (Number.isNaN(deltaMs)) return '—';
  if (deltaMs <= 0) return 'now';
  const secs = Math.round(deltaMs / 1000);
  if (secs < 60) return `~${secs}s`;
  return `~${Math.floor(secs / 60)}m ${secs % 60}s`;
}

/** A live wall-clock that ticks every second so the countdown stays fresh between polls. */
function useNowMs(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function ConfigCards({
  config,
  nextRunAt,
  nowMs,
}: {
  config: PrunesConfig;
  nextRunAt: string | null;
  nowMs: number;
}): JSX.Element {
  const perType = Object.entries(config.perType ?? {});
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatCard label="Window" value={formatRetention(config.afterMs)} accent="text-emerald-400" />
      <StatCard label="Interval" value={formatRetention(config.intervalMs)} />
      <StatCard
        label="Keep last"
        value={config.keepLast != null ? config.keepLast.toLocaleString() : 'unbounded'}
      />
      <StatCard
        label="Next prune"
        value={formatCountdown(nextRunAt, nowMs)}
        accent="text-sky-300"
        hint={perType.length > 0 ? `${perType.length} per-type override(s)` : undefined}
      />
      {perType.length > 0 && (
        <div className="col-span-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 sm:col-span-4">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">
            Per-type overrides
          </span>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {perType.map(([type, ms]) => (
              <span
                key={type}
                className="inline-flex items-center gap-1 rounded bg-zinc-800/80 px-1.5 py-0.5 text-[10px] text-zinc-300"
              >
                <span className="text-zinc-500">{labelForType(type)}</span>
                <span className="tabular-nums text-zinc-100">{formatRetention(ms)}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PruneRow({ run }: { run: PruneRun }): JSX.Element {
  const perType = Object.entries(run.deletedByType);
  return (
    <tr className="border-t border-zinc-800/60 align-top hover:bg-zinc-900/40">
      <td className="px-3 py-2 text-xs text-zinc-400">
        {relativeTime(new Date(run.at).getTime())}
      </td>
      <td className="px-3 py-2">
        <TriggerBadge trigger={run.trigger} />
      </td>
      <td className="px-3 py-2 text-xs tabular-nums text-zinc-400">
        {formatDuration(run.durationMs)}
      </td>
      <td className="px-3 py-2 text-xs tabular-nums text-zinc-100">
        {run.deletedTotal.toLocaleString()}
      </td>
      <td className="px-3 py-2">
        {perType.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {perType.map(([type, count]) => (
              <TypeChip key={type} type={type} count={count} />
            ))}
          </div>
        ) : (
          <span className="text-zinc-600">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-xs tabular-nums text-zinc-400">
        {run.archivedTotal != null ? run.archivedTotal.toLocaleString() : '—'}
      </td>
      <td className="px-3 py-2 text-xs text-red-400">{run.error ?? ''}</td>
    </tr>
  );
}

export function PrunesPage(): JSX.Element {
  const { data, isLoading, isError } = usePrunes();
  const meta = useMeta();
  const prune = usePrune();
  const nowMs = useNowMs();

  const pruneEnabled = meta.data?.pruneEnabled ?? false;
  const runs = data?.runs ?? [];
  const config = data?.config ?? null;

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
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between px-1">
        <h3 className="text-[10px] uppercase tracking-wide text-zinc-500">Prune activity</h3>
        <button
          type="button"
          onClick={onPrune}
          disabled={!pruneEnabled || prune.isPending}
          title={
            pruneEnabled
              ? 'Run a prune cycle now'
              : 'Mutations are disabled (configure authorizeAction to enable on-demand pruning).'
          }
          className="rounded border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 hover:border-emerald-500 hover:text-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {prune.isPending ? 'Pruning…' : 'Prune now'}
        </button>
      </div>

      {config ? (
        <ConfigCards config={config} nextRunAt={data?.nextRunAt ?? null} nowMs={nowMs} />
      ) : (
        <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-6 text-center text-xs text-zinc-600">
          No retention window is configured. Set a `prune` option to enable automatic pruning.
        </div>
      )}

      {isLoading && <p className="px-1 py-2 text-xs text-zinc-600">Loading prune runs…</p>}
      {isError && <p className="px-1 py-2 text-xs text-red-400">Failed to load prune runs.</p>}

      {!isLoading && !isError && runs.length === 0 && (
        <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-12 text-center text-xs text-zinc-600">
          No prune runs recorded yet on this pod.
        </div>
      )}

      {runs.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-zinc-500">
                <th className="px-3 py-2 font-normal">Time</th>
                <th className="px-3 py-2 font-normal">Trigger</th>
                <th className="px-3 py-2 font-normal">Duration</th>
                <th className="px-3 py-2 font-normal">Deleted</th>
                <th className="px-3 py-2 font-normal">By type</th>
                <th className="px-3 py-2 font-normal">Archived</th>
                <th className="px-3 py-2 font-normal">Error</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run, index) => (
                <PruneRow key={`${run.at}:${index}`} run={run} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
